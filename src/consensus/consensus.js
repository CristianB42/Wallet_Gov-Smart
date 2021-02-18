import BaseConsensus from "./consensus-base";

import consts from "consts/consts"

const {client} = PandoraLibrary.sockets.client;
const {BasicSocket} = PandoraLibrary.sockets.basic;
const {Helper} = PandoraLibrary.helpers;

const {NodeConsensusTypeEnum} = PandoraLibrary.enums;
const {BigNumber} = PandoraLibrary.utils;
const {MarshalData} = PandoraLibrary.marshal;

const {BlockModel} = PandoraLibrary.blockchain.block;
const {TokenDataModel} = PandoraLibrary.blockchain.chain.token;
const {WalletAddressTypeEnum} = PandoraLibrary.blockchain.wallet;

class Consensus extends BaseConsensus{

    constructor(settings) {

        super(settings);

        this._settings.address = consts.fallback;

        this._promises = {
            blocks: { },
            blocksByHash:{ },
            transactions : { },
            tokens: {},
        };

        this._data = {

            start: 0,
            end: 0,
            hash: Buffer.alloc(32),
            kernelHash: Buffer.alloc(32),
            prevHash: Buffer.alloc(32),
            prevKernelHash: Buffer.alloc(32),
            chainwork: BigNumber(0),

            blocksInfo:{ },
            blocks: { },
            blocksByHash:{ },
            transactions : { },
            accounts: { },
            tokens:{ },
        };

        this._downloadPendingTransactionsEnabled = false;

    }

    async _started(){

        const sock = client( this._settings.address, {

            reconnection: true,
            maxHttpBufferSize: PandoraPay.argv.networkSettings.networkMaxSize,
            query: {
                handshake: JSON.stringify({
                    short: PandoraPay.argv.settings.applicationShort,

                    build: PandoraPay.argv.settings.buildVersion,

                    net: {
                        type: PandoraPay.argv.settings.networkType,
                    },

                    address: '',
                    consensus: NodeConsensusTypeEnum.CONSENSUS_RPC
                })
            }
        });

        this._client = new BasicSocket( PandoraPay._scope, this._settings.address, sock, undefined );

        [ "connect", "disconnect"  ].map( fct => this._client[fct] = sock[fct].bind( sock ) );
        [ "emit", "on","once" ].map( fct => this._client['_'+fct] = sock[fct].bind( sock ) );

        this._client.on("connect", ()=> this.status = "online" );
        this._client.on("disconnect", ()=> this.status = "offline" );

        this._client.once("handshake", handshake =>{

            if (handshake.short === PandoraPay.argv.settings.applicationShort) {
                this.status = "syncing";
                this._client.emit("ready!", "go!");
            }
            else
                this._client.close();
        });

        this._client.on("blockchain-protocol/new-block", this._processBlockchainNewBlock.bind(this) );

        this._client.on("connect", ()=>{

            this.getBlockchain();
            this._downloadGenesis();
            this._initPromiseResolve(true);

        });

    }

    getBlockchain(){

        if (this._client)
            return this._client.emit("blockchain/get-info", undefined, this._processBlockchain.bind(this) );
    }

    async _processBlockchainNewBlock(data) {

        await this._processBlockchainInfo(data);

    }

    async _processBlockchain(data){

        await this._processBlockchainInfo(data);

        this.status = "sync";

    }

    async _processBlockchainInfo(data){

        this._data.end = data.blocks;
        this._data.start = data.start;
        this._data.hash = data.hash;
        this._data.prevHash = data.prevHash;
        this._data.prevKernelHash = data.prevKernelHash;

        this._data.chainwork = MarshalData.decompressBigNumber( data.chainwork );

        PandoraPay.mainChain.data.end = data.blocks;

        this.emit('consensus/blockchain-info-updated', this._data );

        await this.downloadBlocksHashes();

        await this._downloadAccountsData();
        await this._downloadAccountsTransactions();

        await this.downloadPendingTransactions();

    }

    async downloadBlocksHashes(starting = this.starting, ending = this.ending-1){

        let i, done = false;
        for (i = ending; i >= starting && !done ; i-- ){

            const blockInfo = await this._client.emitAsync("blockchain/get-block-info", {index: i}, 0);

            if (!blockInfo || !blockInfo.hash) return; //disconnected

            blockInfo.hash = Buffer.from(blockInfo.hash);
            blockInfo.kernelHash = Buffer.from(blockInfo.kernelHash);

            if (!this._data.blocksInfo[i] || !this._data.blocksInfo[i].hash.equals(blockInfo.hash)){

                if (this._data.blocksInfo[i] && !this._data.blocksInfo[i].hash.equals(blockInfo.hash)){

                    this.emit('consensus/block-deleted', {hash: blockInfo.hash, height: i} );

                    const block = this._data.blocks[i];
                    if (block){
                        const txs = await block.getTransactions();
                        const data = {};
                        for (const tx of txs) {
                            data[tx.hash().toString("hex")] = tx;
                            delete this._data.transactions[tx.hash().toString("hex")];
                        }
                        this.emit('consensus/tx-deleted', {transactions: data} );
                    }

                    delete this._data.blocks[i];
                    delete this._data.blocksByHash[blockInfo.hash.toString("hex")];

                    await this.getBlock(i);

                }

                this._data.blocksInfo[i] = blockInfo;
                this.emit('consensus/block-info-downloaded', blockInfo );

            }else {
                if (this._data.blocksInfo[i] && this._data.blocksInfo[i].hash.equals( blockInfo.hash) )
                    done = true;

            }


        }

        return true;

    }

    async downloadNonceIncludingMemPool(account){

        const nonce = await this._client.emitAsync("account/get-nonce-including-mem-pool", { account }, 0);
        return nonce;

    }

    async _downloadAccountsData(){

        for (const account in this._data.accounts)
            await this._downloadAccountData(account);

    }

    async _downloadAccountData(account){

        let accountData = await this._client.emitAsync("account/get-account", { account }, 0);
        if (!accountData) return false;

        const prevAcc = this._data.accounts[account];

        const address = PandoraPay.cryptography.addressValidator.validateAddress( account );
        if ( address ){

            const type = WalletAddressTypeEnum.WALLET_ADDRESS_TRANSPARENT;

            try{

                if (accountData.found){


                    const {balances, nonce, delegate, delegateVersion} = accountData.account;
                    const publicKeyHash = address.publicKeyHash;

                    if ( JSON.stringify(prevAcc.balances) !== JSON.stringify(balances) || prevAcc.nonce !== nonce ||
                        prevAcc.delegateVersion !== delegateVersion || JSON.stringify(prevAcc.delegate) !== delegate ){

                        this._data.accounts[account].balances = balances;
                        this._data.accounts[account].nonce = nonce;
                        this._data.accounts[account].delegateVersion = delegateVersion;
                        this._data.accounts[account].delegate = delegate;

                        //remove old balance
                        const balancesOld = await PandoraPay.mainChain.data.accountHashMap.getBalances(publicKeyHash);
                        const nonceOld = await PandoraPay.mainChain.data.accountHashMap.getNonce(publicKeyHash) || 0;
                        const delegateOld = await PandoraPay.mainChain.data.accountHashMap.getDelegate(publicKeyHash);

                        if (balancesOld)
                            for (const currencyToken in balancesOld)
                                await PandoraPay.mainChain.data.accountHashMap.updateBalance( publicKeyHash, - balancesOld[currencyToken], currencyToken, );

                        //update with new balance
                        if (balances )
                            for (const balance of balances) {
                                await this.getTokenByHash(balance.tokenCurrency);
                                await PandoraPay.mainChain.data.accountHashMap.updateBalance(publicKeyHash, balance.amount, balance.tokenCurrency,);
                            }

                        if (nonce ) {
                            const diffNonce = nonce - nonceOld;
                            for (let i = 0; i < Math.abs(diffNonce); i++)
                                await PandoraPay.mainChain.data.accountHashMap.updateNonce(publicKeyHash, diffNonce > 0 ? 1 : -1);
                        }

                        if (delegate ) {
                            const diffDelegateNonce = delegate.delegateStakeNonce - (delegateOld ? delegateOld.delegateStakeNonce : 0);
                            for (let i = 0; i < Math.abs(diffDelegateNonce); i++)
                                await PandoraPay.mainChain.data.accountHashMap.updateDelegate(publicKeyHash, diffDelegateNonce > 0 ? 1 : -1, delegate.delegateStakePublicKey, delegate.delegateStakeFee);
                        }

                        this.emit('consensus/account-transparent-update', { account, balances, nonce, delegateVersion, delegate, type  } );

                    }

                }

                this.emit('consensus/account-update-loaded', { account, loaded: true  } );

            }catch(err){
                console.error(err);
            }

            return true;
        }

    }

    setAccounts( accounts, deletePrevAccounts = false ){

        if (deletePrevAccounts)
            this._data.accounts = {};

        for (const account in accounts)
            this._data.accounts[account] = {
                publicKeyHash: accounts[account].publicKeyHash,
            };

    }

    async _downloadGenesis(){

        const genesis = await this._client.emitAsync("blockchain/genesis", { }, 0);
        if (!genesis) return;

        this._data.genesis = genesis;

        this.emit('consensus/blockchain-info-genesis-updated', genesis );

    }

    async _downloadAccountsTransactions() {

        for (const account in this._data.accounts)
            await this.downloadAccountTransactions(account);

    }

    includeTransactionToPending(tx){

        const txs = {};
        txs[tx.hash().toString('hex')] = {
            queued: false,
        }

        for (const account in this._data.accounts)
            for (const text of ['vin','vout'])
                if (tx[text])
                    for (const vin of tx[text])
                        if (vin.publicKeyHash && vin.publicKeyHash.toString('hex') === this._data.accounts[account].publicKeyHash ){
                            this.emit('consensus/account-update-tx-count', { account, txCount: 0, txCountPending: 1, clear: false});
                            this.emit('consensus/account-update-pending-txs', { account, txs: txs, next: undefined, clear: false } )
                        }

    }

    async downloadAccountTransactions(account) {

        const address = PandoraPay.cryptography.addressValidator.validateAddress( account );
        if (address){

            const txCount = await this._client.emitAsync("transactions/account/get-transaction-count", {account }, 0);
            const txCountPending = await this._client.emitAsync("mem-pool/content-count", {account }, 0);

            if (!txCountPending && !txCount) return;

            this.emit('consensus/account-update-tx-count', {account, txCount, txCountPending, clear: true });

            await this.downloadAccountTransactionsSpecific( {account, limit: 10} );
            await this.downloadPendingTransactionsSpecific( {account} );

            return true;
        }

    }

    async downloadAccountTransactionsSpecific({account, index, limit} ){

        const data = await this._client.emitAsync("transactions/account/get-transactions-ids", { account, index, limit }, 0);

        if (!data || !data.out) return;

        this.emit('consensus/account-update-txs', {account, txs: data.out, next: data.next, });

        for (const key in data.out)
            await this.getTransactionByHash( data.out[key].toString("hex"), false );

    }

    async downloadPendingTransactions( account, index ){

        if (!this._downloadPendingTransactionsEnabled) return;

        const txCount = await this._client.emitAsync("mem-pool/content-count", {account}, 0);
        if (!txCount) return;

        this.emit('consensus/pending-transactions-count', {count: txCount});

        return this.downloadPendingTransactionsSpecific({account, index});
    }

    async downloadPendingTransactionsSpecific( {account, index, limit} ){

        const data = await this._client.emitAsync("mem-pool/content-ids", { account, index }, 0);

        if (!data|| !data.out) return ;

        if (!account)
            this.emit('consensus/pending-transactions', { txs: data.out, next: data.next, clear: index === undefined } );
        else
            this.emit('consensus/account-update-pending-txs', { account, txs: data.out, next: data.next, clear: index === undefined } );

        for (const hash in data.out)
            await this.getTransactionByHash(hash, true);

    }

    /**
     * TOKENS
     */

    async downloadTokens({index}){

        const tokensCount = await this._client.emitAsync("tokens/content-count", 0);
        if (!tokensCount) return;

        this.emit('consensus/tokens-count', { count: tokensCount});

        await this._downloadTokensSpecific({index});

    }

    async _downloadTokensSpecific({index, limit}){

        const tokens = await this._client.emitAsync("tokens/content-ids", { index, limit}, 0);
        if (!tokens) return;

        this.emit('consensus/tokens-ids', { tokens: tokens.out, next: tokens.next });

        for (const token of tokens.out)
            await this.getTokenByHash(token);

    }

    async startDownloadingTokens(){
        if (this._downloadTokensEnabled ) return;

        this._downloadTokensEnabled = true;
        return this.downloadTokens({index: 0});
    }

    async stopDownloadingTokens(){
        this._downloadTokensEnabled = false;
    }

    /**
     * PENDING TRANSACTIONS
     */

    async startDownloadPendingTransactions(){

        if (this._downloadPendingTransactionsEnabled) return;

        this._downloadPendingTransactionsEnabled = true;
        return this.downloadPendingTransactions();
    }

    async stopDownloadPendingTransactions(){

        this._downloadPendingTransactionsEnabled = false;
    }

    async _stopped(){

    }


    async getBlockByHash(hash){

        if (this._data.blocks[hash]) return this._data.blocksByHash[hash];
        if (this._promises.blocks[hash]) return this._promises.blocks[hash];

        this._promises.blocks[hash] = new Promise( async (resolve, reject) => {

            try{

                const blockData = await this._client.emitAsync("blockchain/get-block", { hash, type: "buffer"}, 0  );
                if (!blockData) throw Error("Block was not received")

                const block = await this._includeBlock( Buffer.from(blockData) );
                resolve(block);

            }catch(err){
                reject(err);
            }finally{
                delete this._promises.blocks[hash];
            }

        } );

        return this._promises.blocks[hash];
    }

    async getBlock(height){

        if (this._data.blocks[height]) return this._data.blocks[height];

        this._promises.blocks[height] = new Promise( async (resolve, reject) => {

            try{
                const blockData = await this._client.emitAsync("blockchain/get-block-by-height", {index: height, type: "buffer"}, 0  );
                if (!blockData) throw Error("Block was not received")

                const block = await this._includeBlock( Buffer.from(blockData) );
                resolve(block);

            }catch(err){
                reject(err);
            }finally{
                delete this._promises.blocks[height];
            }

        });

        return this._promises.blocks[height];
    }

    async _includeBlock(block){

        if (Buffer.isBuffer(block))
            block = new BlockModel( {
                ...PandoraPay._scope,
                chain: PandoraPay._scope.mainChain
            }, undefined, block );

        this.emit('consensus/block-downloaded', block );

        this._data.blocks[block.height] = block;
        this._data.blocksByHash[block.hash().toString("hex")] = block;

        const data = {};
        const txs = await block.getTransactions();
        for (const tx of txs) {
            tx.__extra = {
                height: block.height,
                timestamp: block.timestamp,
            };
            this._data.transactions[tx.hash().toString("hex")] = tx;
            data[tx.hash().toString("hex")] = tx;
        }
        this.emit('consensus/tx-downloaded', {transactions: data} );

        return block;
    }

    async getTransactionByHash(hash, isPending = false ){

        let tx = this._data.transactions[hash] || this._promises.transactions[hash];
        if (tx){
            tx = await tx;
            if ((isPending && !tx.__extra.height ) || (!isPending && tx.__extra.height ))
                return tx;
        }

        this._promises.transactions[hash] = new Promise( async (resolve, reject ) => {

            try{

                const txData = await this._client.emitAsync("transactions/get-transaction", { hash, type: "buffer" }, 0  );
                if (!txData) //disconnected
                    throw Error("tx fetch failed");

                const tx = PandoraPay._scope.mainChain.transactionsValidator.cloneTx( txData.tx );

                if (tx.hash().toString('hex') !== hash )
                    throw Error("Transaction hash is invalid");

                tx.__extra = {
                    height: txData.block,
                    timestamp: txData.blockTimestamp,
                    confirmations: txData.confirmations,
                    memPoolQueued: txData.memPoolQueued,
                    memPool: txData.memPool,
                };


                const data = {};
                data[hash] = tx;

                this.emit('consensus/tx-downloaded', {transactions: data} );

                this._data.transactions[hash] = tx;
                resolve(tx);
            }catch(err){
                reject(err);
            } finally{
                delete this._promises.transactions[hash];
            }
        } );

        return this._promises.transactions[hash];
    }

    async getTransactionByHeight(blockHeight){

    }

    async getTokenByHash(hash){

        if (this._data.tokens[hash]) return this._data.tokens[hash];

        this._promises.tokens[hash] = new Promise( async (resolve, reject) =>{

            let token;
            try{

                const tokenData = await this._client.emitAsync("tokens/get-token", { token: hash, type: "json" }, 0  );

                if (!tokenData) throw Error("token fetch failed");

                token = new TokenDataModel({
                    ...PandoraPay._scope,
                    chain: PandoraPay._scope.mainChain
                }, undefined, tokenData );

                const data = {};
                data[hash] = token;
                this.emit('consensus/tokens-downloaded', {tokens: data} );

                this._data.tokens[hash] = token;
                resolve(token);

            }catch(err){
                reject(err);
            }finally{
                delete this._promises.tokens[hash];
            }

        });

        return this._promises.tokens[hash];
    }

    get starting(){
        return Math.max(0 , this._starting || this._data.end - 15);
    }

    get ending(){
        return this._ending || this._data.end;
    }

}

export default new Consensus({});