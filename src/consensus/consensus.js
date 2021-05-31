import BaseConsensus from "./consensus-base";

import consts from "consts/consts"

class Consensus extends BaseConsensus{

    processBlockchain(data){

        data = JSON.parse(data)

        this._data.end = data.end;
        this._data.hash = data.hash;
        this._data.prevHash = data.prevHash;

        this.emit('consensus/blockchain-info-updated', this._data );
        this.downloadBlocksHashes()

    }

    async downloadBlocksHashes(starting = this.starting, ending = this.ending-1 ){

        let i, done = false;
        for (i = ending; i >= starting && !done ; i-- ){

            const blockInfoData = await PandoraPay.network.getNetworkBlockInfo( i, "" );
            const blockInfo = JSON.parse(blockInfoData)

            if (!blockInfo || !blockInfo.hash){
                this.emit('consensus/error', "Error getting block info" );
                return
            }

            blockInfo.height = i

            if (this._data.blocksInfo[i] && this._data.blocksInfo[i].hash === blockInfo.hash ){
                done = true;
                continue
            }

            if (!this._data.blocksInfo[i] || !this._data.blocksInfo[i].hash === blockInfo.hash ){

                if (this._data.blocksInfo[i] && this._data.blocksInfo[i].hash !== blockInfo.hash ){
                    this.emit('consensus/block-deleted', {hash: blockInfo.hash, height: i} );
                }

                this._data.blocksInfo[i] = blockInfo;
                this.emit('consensus/block-info-downloaded', blockInfo );

            }

        }

    }

    stopDownloadPendingTransactions(){

    }

    _includeBlock(blkComplete){

        this.emit('consensus/block-downloaded', blkComplete );
        this._data.blocks[blkComplete.block.height] = blkComplete;
        this._data.blocksByHash[blkComplete.block.hash] = blkComplete;

        const data = {};
        for (const tx of blkComplete.txs) {
            tx.__extra = {
                height: blkComplete.block.height,
                timestamp: blkComplete.block.timestamp,
            };
            this._data.transactions[tx.bloom.hash] = tx;
            data[tx.bloom.hash] = tx;
        }
        this.emit('consensus/tx-downloaded', {transactions: data} );

    }

    getBlockByHash(hash){

        if (this._data.blocks[hash]) return this._data.blocksByHash[hash];
        if (this._promises.blocks[hash]) return this._promises.blocks[hash];

        return this._promises.blocks[hash] = new Promise( async (resolve, reject) => {
            try{

                const blockData = await PandoraPay.network.getNetworkBlockComplete( hash );
                if (!blockData) throw Error("Block was not received")

                const blkComplete = JSON.parse(blockData)

                await this._includeBlock( blkComplete );
                resolve(blkComplete);

            }catch(err){
                this.emit('consensus/error', "Error getting block" );
                reject(err);
            }finally{
                delete this._promises.blocks[hash];
            }

        })
    }

    getBlock(height){

        if (typeof height === "string") {
            height = Number.parseInt(height)
        }

        if (this._data.blocks[height]) return this._data.blocks[height];

        return this._promises.blocks[height] = new Promise( async (resolve, reject) => {

            try{
                console.log(height, typeof height)
                const blockData = await PandoraPay.network.getNetworkBlockComplete( height );
                if (!blockData) throw Error("Block was not received")

                const blkComplete = JSON.parse(blockData)

                await this._includeBlock( blkComplete );
                resolve(blkComplete);

            }catch(err){
                reject(err);
            }finally{
                delete this._promises.blocks[height];
            }

        });

    }

    getTransactionByHash(){

    }
    getTransaction(){

    }

}

export default new Consensus({});
