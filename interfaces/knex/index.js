const knex = require('knex');
const uuidv4 = require('uuid/v4');
module.exports = class {

    constructor() {
        this.collections = {};
        this.collectionNames = [];
        this.collectionDefs = {};
    }

    async init({ unsafe = false, lists = {}, connection = {}, collectionDefs = {}} = {}) {
        this.collectionDefs = collectionDefs;
        this.db = knex({ ...connection });
    }
    async close() {
        const res = await this.db.destroy();
        return true;
    }

    async createCollection(collectionName, { initialItems = [], modelDef }) {
        this.collectionDefs[collectionName] = modelDef;
        return new Promise(async (resolve, reject) => {
            const exists = await this.db.schema.hasTable(collectionName);
            if(!exists) {
                modelDef.id = modelDef.id ? modelDef.id : 'string';
                await this.db.schema.createTable(collectionName, async (table) => {
                    Object.keys(modelDef).forEach(key => {
                        if (typeof(modelDef[key]) === 'string') {
                            table[modelDef[key]](key);
                        } else {
                            const col = table[modelDef[key].type](key);

                            if(modelDef[key].primaryKey) {
                                col.primary();
                            }
                        }
                    });
                });
            }

            this.create(collectionName, { data: initialItems });
            this.collectionNames.push(collectionName);

            resolve(true);
        });
    }

    async removeCollection(collectionName) {
        return await this.db.schema.dropTable(collectionName)
    }

    async find(listName, { where = {}, limit, offset, include =  false, orderBy } = {}) {
        let or = false;
        if(where.$or) {
            or = where.$or
            delete where.$or;
        }

        let res = this.db
            .from(listName)

        const whereMethods = {
            $like: (fieldName, fieldVal, ref) => { ref.where(fieldName, 'like', fieldVal.$like) },
            $notLike: (fieldName, fieldVal, ref) => { ref.whereNot(fieldName, 'like', fieldVal.$notLike) },
            $gt: (fieldName, fieldVal, ref) => { ref.where(fieldName, '>', fieldVal.$gt) },
            $gte: (fieldName, fieldVal, ref) => { ref.where(fieldName, '>=', fieldVal.$gte) },
            $lt: (fieldName, fieldVal, ref) => { ref.where(fieldName, '<', fieldVal.$lt) },
            $lte: (fieldName, fieldVal, ref) => { ref.where(fieldName, '<=', fieldVal.$lte) },
            $in: (fieldName, fieldVal, ref) => { ref.whereIn(fieldName, fieldVal.$in) },
        }

        function covert(fieldName, fieldVal, ref) {
            if(typeof(fieldVal) !== 'object') {
                ref.where(listName+'.'+fieldName, fieldVal);
            } else {
                Object.keys(whereMethods).forEach((meth) => {
                    if (fieldVal[meth] !== undefined) {
                        whereMethods[meth](listName+'.'+fieldName, fieldVal, ref);
                    }
                });
            }
        }

        Object.keys(where).forEach((key) => {
            covert(key, where[key], res);
        });

        if(limit !== undefined) {
           res.limit(limit);
        }

        if(offset) {
            res.offset(offset);
        }

        if(or) {
            or.forEach(orCond => {
                Object.keys(orCond).forEach((key) => {
                    res.orWhere(function() {
                        covert(key, orCond[key], this);
                        Object.keys(where).forEach((key) => {
                            covert(key, where[key], this);
                        });
                    });
                });
            })
        }

        if(orderBy) {
            res.orderBy(orderBy[0], orderBy[1]);
        }

        if(include) { // handle right joins
            Object.keys(include).forEach(key => {
                if (include[key].on && include[key].required) {
                    const onKey = Object.keys(include[key].on).pop();
                    const fKey = key+"."+include[key].on[onKey];
                    const lKey = listName+"."+onKey;

                    res.rightJoin(key, {[lKey]: fKey});
                }
            });
        }

        let fields = undefined;

        if (include) { // Prevent right join data by specifying fields
            fields = [];
            Object.keys(this.collectionDefs[listName]).forEach(key => {
                //fields.push(`${listName}.${key} as ${listName}.${key}`)
                fields.push(`${listName}.${key} as ${key}`);
            });
        }

        const fres = await res.select(fields);

        const objectMap = fres.map((row) => {
            return Object.keys(row).reduce((acc, val) => {
                return {
                    ...acc,
                    [val]:row[val]
                }
            }, {});
        });

        if(include) { // find and add join/include data
            const includeKeys = Object.keys(include);
            for(let i = 0; i < includeKeys.length; i++) {
                // Sensible defaults for has many x
                const key = includeKeys[i];
                let lKey = `id`;
                let fKey = `${listName}_id`;

                if (include[key].on) {
                    const onKey = Object.keys(include[key].on).pop();
                    fKey = include[key].on[onKey];
                    lKey = onKey;
                } else if(this.collectionDefs[listName][`${includeKeys[i]}_id`] !== undefined) {
                    // Sensible defaults for belongs to x
                    fKey = `${includeKeys[i]}_id`;
                    fKey = [lKey, lKey=fKey][0];
                }

                const lKeys = objectMap.map(item => item[lKey])
                const subResults = await this.find(includeKeys[i], {
                    where: {
                        [fKey]:{
                            $in: lKeys
                        }
                    }
                });

                objectMap.map(item => {
                    return item[includeKeys[i]] = subResults.filter(i => i[fKey] == item[lKey]);
                });
            }
        }

        return objectMap;
    };

    async create(listName, { data, returnRef = true }) {
        let dataWithId = Array.isArray(data) ? data:[data];

        dataWithId = dataWithId.map((item) => {
            return { id: uuidv4(), ...item };
        });

        for(let d = 0; d < dataWithId.length; d++) {
            const item = dataWithId[d];
            const id = !item.id ? uuidv4():item.id;

            for(let c = 0; c < this.collectionNames.length; c++) {
                const colName = this.collectionNames[c];

                if (item[colName]) {
                    item[colName].forEach((subItem) => {
                        subItem[listName + '_id'] = id;
                    });

                    const subr = await this.create(colName, {
                        data: item[colName],
                        returnRef
                    });

                    delete item[colName];
                }
            }

            dataWithId[d] = { id, ...item };
        }

        await this
            .db(listName)
            .insert(dataWithId);

        const res = Array.isArray(data) ? dataWithId : dataWithId.pop();
        return returnRef ? res : true;
    }

    async findOne(listName, { where = {}, limit, offset, include =  false } = {})  {
        const res = await this.find(listName, { where, limit: 1, offset, include});
        return res.length > 0 ? res.pop() : false;
    };

    async updateOne(listName, { data = {}, where = {}} = {})  {
        return await this.db(listName)
            .where(where)
            .limit(1)
            .update(data)
    };

    async updateMany(listName, { data = {}, where = {}} = {})  {
        return await this.db(listName)
            .where(where)
            .update(data)
    };

    async delete(listName, { where })  {
        return await this.db(listName)
            .where(where)
            .del()
    };
};