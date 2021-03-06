const { MongoClient } = require('mongodb');
const uuidv4 = require('uuid/v4');

const formatters = {
    "$notLike": (res, key) => {
        const reg = res[key].replace(new RegExp('%', 'g'), '.*');
        return { $not: new RegExp(reg) };
    },
    "$like": (res, key) => {
        const reg = res[key].replace(new RegExp('%', 'g'), '.*');
        return new RegExp(reg);
    }
}

function convertWhereToMongo(query) {
    let res = query;

    Object.keys(query).forEach(key => {
        if(Array.isArray(res[key])) {
            res[key].map(i => convertWhereToMongo(i));
        } else if(typeof(res[key]) === 'object') {
            res[key] = convertWhereToMongo(query[key]);
        } else if(formatters[key] !== undefined) {
            res = formatters[key](res, key);
        }
    });

    return res;
}

module.exports = class {

    constructor() {
        this.collectionMapCache = {};
        this.collectionNames = [];
    }

    async init({ port = 27017, dbname = 'test' }) {
        return new Promise((resolve) => {
            const url = `mongodb://127.0.0.1:${port}/${dbname}`;

            MongoClient.connect(url, { useNewUrlParser: true }, (err, connection) => {
                if (err) throw err;
                this.db = connection.db(dbname);
                this.connection = connection;
                resolve();
            });
        })
    }

    async formatJoinAgregate(listName, aggregateOptions = [], include = {}) {
        const includeKeys = Object.keys(include);
        for(let i = 0; i < includeKeys.length; i++) {
            const includeListName = includeKeys[i];

            let localField = 'id'
            let foreignField = listName + '_id'
            const cond = include[includeListName].on;

            if (cond) {
                localField = Object.keys(cond).pop()
                foreignField = Object.values(cond).pop()
            } else {
                const localFields = await this.getCollectionKeys(listName)
                const isChild = localFields.indexOf(includeListName + '_id') > -1;


                localField = isChild ? includeListName + '_id' : 'id';
                foreignField = isChild ? 'id' : listName + '_id';
            }

            aggregateOptions.push({
                $lookup: {
                    from: includeListName,
                    localField,
                    foreignField,
                    as: includeListName
                  }
            });

            // Handle right joins
            if(include[includeListName].required) {
                aggregateOptions.push({
                    $match: {
                        [includeListName]: { $exists: true, $ne: [] }
                    }
                });
            }
        }

        return aggregateOptions;
    }

    async getCollectionKeys(listName, forceLookup = false) {
        if (!forceLookup && this.collectionMapCache[listName]) {
            return this.collectionMapCache[listName];
        }

        const mResult = await this.db.collection(listName).mapReduce(
            function() {
                for (var key in this) { emit(key, null); }
            },
            function(key, stuff) {
                return null;
            },
            {
                query: {},
                out: listName + "_keys"
            }
        );

        return await mResult.distinct("_id");
    }

    async close() {
        return (await this.connection.close()) === null;
    }

    async createCollection(name, { initialItems = [] } = {}) {
        const result = await this.db.createCollection(name);

        if(initialItems.length > 0) {
            await this.db.collection(name).insertMany(initialItems);
        }

        this.collectionNames.push(name);

        return result;
    }

    async removeCollection(listName) {
        return new Promise((resolve) => {
            this.db.collection(listName).drop((err, delOK) => {
                resolve(delOK);
            });
        });
    }

    async create(listName, { data, returnRef = true }) {
        let dataWithId = Array.isArray(data) ? data:[data];

        dataWithId = dataWithId.map((item) => {
            return { id: uuidv4(), ...item };
        });

        for(let d = 0; d < dataWithId.length; d++) {
            const item = dataWithId[d];
            const id = !item.id ? uuidv4():item.id;

            dataWithId[d] = { id, ...item };

            for(let c = 0; c < this.collectionNames.length; c++) {
                const collectionName = this.collectionNames[c];

                if (item[collectionName]) {
                    item[collectionName].forEach((subItem) => {
                        subItem[listName + '_id'] = id;
                    });

                    const subr = await this.create(collectionName, {
                        data: item[collectionName],
                        returnRef
                    });

                    dataWithId[d][collectionName] = subr;
                }
            }
        }

        if (Array.isArray(data)) {
            const res = await this.db.collection(listName).insertMany(dataWithId);
            if (!returnRef) {
                return res.result.ok;
            }
            return await this.db.collection(listName).find( { _id: { $in: Object.values(res.insertedIds) } } ).toArray();;
        } else {
            const res = await this.db.collection(listName).insertOne(dataWithId.pop());
            if (!returnRef) {
                return res.result.ok;
            }

            const findRes = await this.db.collection(listName).find({}).sort({_id:-1}).limit(1).toArray();

            return findRes.pop();
        }
    }

    async find(listName, { where = {}, limit, offset, include =  false, orderBy } = {}) {
        const fixedWhere = convertWhereToMongo(where);
        let order = [];
        if(orderBy) {
            const dir = orderBy[1] == 'asc' ? 1:-1;
            order = (orderBy ? [{ $sort: { [orderBy[0]]: dir } }] : []);
        }

        const aggregateOptions = [
            { $match: fixedWhere },
            ...order
        ];

        if (include) {
            await this.formatJoinAgregate(listName, aggregateOptions, include, this.db);
        }

        let res = await this.db
            .collection(listName)
            .aggregate(aggregateOptions);

        if(limit !== undefined) {
            res = await res.limit(limit);
        }

        if(offset !== undefined) {
            res = await res.skip(offset);
        }

        const result = await res.toArray();

        return await res.toArray();
    }

    async findOne(listName, { where = {}, include = false } = {}) {
        const fixedWhere = convertWhereToMongo(where);

        const aggregateOptions = [
            { $match: fixedWhere },
            { $limit: 1 }
        ];

        if (include) {
            await this.formatJoinAgregate(listName, aggregateOptions, include, this.db);
        }

        const res = await this.db
            .collection(listName)
            .aggregate(aggregateOptions)
            .toArray();

        return res.length > 0 ? res.pop() : false;
    }

    async updateOne(listName, { data = {}, where = {} } = {}) {
        return await this.db
            .collection(listName)
            .updateOne(where, { $set: data }, { multi: true });
    }

    async updateMany(listName, { data = {}, where = {} } = {}) {
        return await this.db
            .collection(listName)
            .updateMany(where, { $set: data }, { multi: true });
    }

    async delete(listName, { where = {} } = {}) {
        return await this.db
            .collection(listName)
            .deleteMany(where)
    }
}