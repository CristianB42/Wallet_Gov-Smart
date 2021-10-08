const promises = {
    txsByHeight: {},
    txsByHash: {},
    unsubscribed: {},
    subscribed: {},
}

export default {

    async subscribeTransaction( {state, dispatch, commit}, txId ){

        if (state.subscribed[txId]) return true

        if (promises.subscribed[txId]) return promises.subscribed[txId];
        return promises.subscribed[txId] = new Promise( async (resolve, reject) => {
            try{

                await PandoraPay.network.subscribeNetwork( txId, PandoraPay.enums.api.websockets.subscriptionType.SUBSCRIPTION_TRANSACTION )

                commit('setSubscribedTxStatus', {txId, status: true})

                resolve(true)
            }catch(err){
                reject(err)
            }finally{
                delete promises.subscribed[txId]
            }
        })
    },

    async unsubscribeTransaction( {state, dispatch, commit}, txId ){

        if (!state.subscribed[txId]) return true

        if (promises.unsubscribed[txId]) return promises.unsubscribed[txId];
        return promises.unsubscribed[txId] = new Promise( async (resolve, reject) => {
            try{

                await PandoraPay.network.unsubscribeNetwork( txId, PandoraPay.enums.api.websockets.subscriptionType.SUBSCRIPTION_TRANSACTION )

                commit('setSubscribedTxStatus', {txId, status: false})

                resolve(true)
            }catch(err){
                reject(err)
            }finally{
                delete promises.unsubscribed[txId]
            }
        })
    },

    async processTx( {state, dispatch, commit, getters}, tx ){

        if (tx.version === PandoraPay.enums.transactions.TransactionVersion.TX_SIMPLE)
            await dispatch('getTokenByHash', PandoraPay.config.coins.NATIVE_TOKEN_FULL_STRING_HEX )
        else if (tx.version === PandoraPay.enums.transactions.TransactionVersion.TX_ZETHER)
            await Promise.all( tx.payloads.map( payload => dispatch('getTokenByHash', payload.token ) ) )

    },

    async includeTx( {state, dispatch, commit, getters}, txJSON ){

        const tx = txJSON.tx

        if (txJSON.info){
            tx.__height = txJSON.info.height
            dispatch('storeTransactionInfo', { hash: tx.hash, txInfo:  txJSON.info  })
        }
        else {
            delete tx.__height
            dispatch('storeTransactionInfo', { hash: tx.hash, txInfo:  { mempool: true}  })
        }

        await dispatch('processTx', tx)
        commit("setTransactions", { txs: [tx] } )

        return tx
    },

    // async decryptTxData( {state, dispatch, commit, getters}, {tx, hash, password = "", commitNow } ){
    //
    //     if (!tx) tx = state.txsByHash[hash]
    //
    //     let decrypted = false
    //
    //     for (const vout of tx.vout){
    //
    //         const walletAddress = getters.walletContains( vout.publicKey )
    //         if ( walletAddress ){
    //             tx.__dataCanBeDecrypted = true
    //
    //             try{
    //
    //                 if ( password || !getters.isWalletEncrypted() ) {
    //                     const data = await PandoraPay.wallet.decryptMessageWalletAddress(tx.data, walletAddress.addressEncoded, password)
    //                     tx.__dataDecrypted = Buffer.from(data, "hex").toString()
    //                     tx.__dataDecryptedError = ""
    //                     decrypted = true
    //                     break
    //                 }
    //
    //                 if ( !password && getters.isWalletEncrypted() ) {
    //                     decrypted = true
    //                     break
    //                 }
    //
    //
    //             }catch(err){
    //                 tx.__dataDecrypted = ""
    //                 tx.__dataDecryptedError = err.toString()
    //                 decrypted = true
    //                 break
    //             }
    //
    //         }
    //     }
    //
    //     if (!decrypted){
    //         tx.__dataDecrypted = ""
    //         tx.__dataDecryptedError = "Data can't be decrypted"
    //     }
    //
    //     if (commitNow)
    //         commit("setTransactions", { txs: [tx] } )
    //
    // },

    getTransactionByHash( {state, dispatch, commit}, hash){

        if (state.txsByHash[hash]) return state.txsByHash[hash];
        if (promises.txsByHash[hash]) return promises.txsByHash[hash];

        return promises.txsByHash[hash] = new Promise( async (resolve, reject ) => {

            try{

                const data = await PandoraPay.network.getNetworkTransaction( hash );
                if (!data) throw "tx fetch failed"; //disconnected

                const tx = JSON.parse(MyTextDecode(data))

                resolve( await dispatch('includeTx', tx) );

            }catch(err){
                console.error(err)
                reject(err);
            } finally{
                delete promises.txsByHash[hash];
            }
        } );
    },

    async getTransactionByHeight( {state, dispatch, commit}, height){

        if (typeof height === "string") height = Number.parseInt(height)

        if (state.txsByHeight[height]) return state.txsByHeight[height];
        if (promises.txsByHeight[height]) return promises.txsByHeight[height];

        return promises.txsByHeight[height] = new Promise( async (resolve, reject ) => {

            try{

                const data = await PandoraPay.network.getNetworkTransaction( height );
                if (!data) throw "tx fetch failed"; //disconnected

                const tx = JSON.parse(MyTextDecode(data))

                resolve( await dispatch('includeTx', tx) );

            }catch(err){
                console.error(err)
                reject(err);
            } finally{
                delete promises.txsByHeight[height];
            }
        } );

    },

    txNotification({state, dispatch, commit}, { txHash, extraInfo }) {
        dispatch('txInfoNotification', { txHash, extraInfo } )
        commit('updateTxNotification', { txHash, extraInfo })
    }

}
