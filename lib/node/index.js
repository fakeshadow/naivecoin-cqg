const superagent = require('superagent');
const Transaction = require('../blockchain/transaction');
const Block = require('../blockchain/block');
const Blocks = require('../blockchain/blocks');
const Transactions = require('../blockchain/transactions');
const R = require('ramda');
const { createApolloFetch } = require('apollo-fetch');
const { queries } = require('../graphql/queries');
const { mutations } = require('../graphql/mutations');

class Node {
    constructor(host, port, peers, blockchain) {
        this.host = host;
        this.port = port;
        this.me = `http://${this.host}:${this.port}/graphql`;
        this.peers = [];
        this.peerMap = {};
        this.blockchain = blockchain;
        this.hookBlockchain();
        this.connectToPeers(peers);
    }

    hookBlockchain() {
        // Hook blockchain so it can broadcast blocks or transactions changes
        this.blockchain.emitter.on('blockAdded', block => {
            this.broadcast(this.sendLatestBlock, block);
        });

        this.blockchain.emitter.on('transactionAdded', newTransaction => {
            this.broadcast(this.sendTransaction, newTransaction);
        });

        this.blockchain.emitter.on('blockchainReplaced', blocks => {
            this.broadcast(this.sendLatestBlock, R.last(blocks));
        });
    }

    peerAlreadyKnows(peer, find) {
        if (find.url === this.me || peer.url === find.url) {
            return true;
        }
        return this.peerMap[peer.url].length === 0 ||
            this.peerMap[peer.url].find(p => p === find.url) === undefined
            ? false
            : true;
    }

    connectToPeer(newPeer) {
        return this.connectToPeers([newPeer]);
    }

    connectToPeers(newPeers) {
        // Connect to every peer
        let success = false;
        let message = '';
        newPeers.forEach(peer => {
            if (this.peerMap[peer.url] === undefined) {
                this.peerMap[peer.url] = [];
            }
            // If it already has that peer, ignore.
            if (
                !this.peers.find(element => {
                    return element.url == peer.url;
                }) &&
                peer.url !== this.me
            ) {
                this.sendPeer(peer, { url: this.me });
                message = `Peer ${peer.url} added to connections.`;
                console.info(message);
                this.peers.push(peer);
                success = true;
                this.initConnection(peer);
                this.broadcast(this.sendPeer, peer);
            } else if (peer.url === this.me) {
                message = `Peer ${
                    peer.url
                } not added to connections, because it's myself.`;
                console.info(message);
            } else {
                message = `Peer ${
                    peer.url
                } not added to connections, because I already have him as a peer.`;
                console.info(message);

                //We send the peer along if we already know and trust him
                //I'm still curious as to what this does to performance.. 
                this.broadcast(this.sendPeer, peer);
            }
        }, this);

        return {
            success,
            message
        };
    }

    initConnection(peer) {
        // It initially gets the latest block and all pending transactions
        this.getLatestBlock(peer);
        this.getTransactions(peer);
    }

    sendGraphqlRequest(peer, query, variables, callback, handleError) {
        const fetch = createApolloFetch({
            uri: peer.url
        });

        return fetch({
            query,
            variables
        })
            .then(res => {
                if (res.errors && res.errors.length > 0) {
                    throw Error(JSON.stringify(res.errors, null, 3));
                }
                callback(res);
            })
            .catch(handleError);
    }

    sendPeer(peer, peerToSend) {
        if (this.peerAlreadyKnows(peer, peerToSend)) {
            const message = `Peer ${peer.url} already knows ${
                peerToSend.url
            } - No need to send!`;
            console.info(message);
            return message;
        }

        console.info(`Sending ${peerToSend.url} to peer ${peer.url}.`);
        return this.sendGraphqlRequest(
            peer,
            mutations.CONNECT_TO_PEER,
            { url: peerToSend.url },
            res => {
                if (!this.peerAlreadyKnows(peer, peerToSend)) {
                    this.peerMap[peer.url].push(peerToSend.url);
                }
                return res.data;
            },
            err =>
                console.warn(
                    `Unable to send me to peer ${peer.url}: ${err.message}`
                )
        );
    }

    syncBlocks() {
        this.broadcast(this.getLatestBlock)
    }

    getLatestBlock(peer) {
        console.info(`Getting latest block from: ${peer.url}`);
        return this.sendGraphqlRequest(
            peer,
            queries.LAST_BLOCK,
            null,
            res =>
                this.checkReceivedBlock(
                    Block.fromJson(res.data.lastBlock),
                    peer
                ),
            err =>
                console.warn(
                    `Unable to get latest block from ${peer.url}: ${
                        err.message
                    }`
                )
        );
    }

    sendLatestBlock(peer, block) {
        console.info(`Sending latestBlock to peer ${peer.url}.`);
        return this.sendGraphqlRequest(
            peer,
            mutations.SEND_LATEST_BLOCK,
            { data: block, peer: this.me },
            res => res.data,
            err =>
                console.warn(
                    `Unable to post latest block to ${peer.url}: ${err.message}`
                )
        );
    }

    getBlocks(peer) {
        console.info(`Getting blocks from: ${peer.url}`);
        return this.sendGraphqlRequest(
            peer,
            queries.GET_BLOCKS,
            null,
            res =>
                this.checkReceivedBlocks(
                    Blocks.fromJson(res.data.blocks),
                    peer
                ),
            err =>
                console.warn(
                    `Unable to get blocks from ${peer.url}: ${err.message}`
                )
        );
    }

    sendTransaction(peer, transaction) {
        console.info(
            `Sending transaction '${transaction.id}' to: '${peer.url}'`
        );
        return this.sendGraphqlRequest(
            peer,
            mutations.CREATE_TRANSACTION,
            { data: transaction },
            res => res.data,
            err =>
                console.warn(
                    `Unable to post a new transaction to ${peer.url}: ${
                        err.message
                    }`
                )
        );
    }

    getTransactions(peer) {
        console.info(`Getting unconfirmed transactions from: ${peer.url}`);
        return this.sendGraphqlRequest(
            peer,
            queries.UNCONFIRMED_TRANSACTIONS,
            null,
            res =>
                this.syncTransactions(
                    Transactions.fromJson(res.data.unconfirmedTransactions)
                ),
            err =>
                console.warn(
                    `Unable to get unconfirmed transations from ${peer.url}: ${
                        err.message
                    }`
                )
        );
    }

    getConfirmation(peer, transactionId) {
        // Get if the transaction has been confirmed in that peer
        const URL = `${
            peer.url
        }/blockchain/blocks/transactions/${transactionId}`;
        console.info(`Getting transactions from: ${URL}`);
        return superagent
            .get(URL)
            .then(() => {
                return true;
            })
            .catch(() => {
                return false;
            });
    }

    getConfirmations(transactionId) {
        // Get from all peers if the transaction has been confirmed
        let foundLocally =
            this.blockchain.getTransactionFromBlocks(transactionId) != null
                ? true
                : false;
        return Promise.all(
            R.map(peer => {
                return this.getConfirmation(peer, transactionId);
            }, this.peers)
        ).then(values => {
            return R.sum([foundLocally, ...values]);
        });
    }

    broadcast(fn, ...args) {
        // Call the function for every peer connected
        console.info('Broadcasting');
        this.peers.map(peer => {
            fn.apply(this, [peer, ...args]);
        }, this);
    }

    syncTransactions(transactions) {
        // For each received transaction check if we have it, if not, add.
        R.forEach(transaction => {
            let transactionFound = this.blockchain.getTransactionById(
                transaction.id
            );

            if (transactionFound == null) {
                console.info(`Syncing transaction '${transaction.id}'`);
                this.blockchain.addTransaction(transaction);
            }
        }, transactions);
    }

    checkReceivedBlock(block, peer) {
        return this.checkReceivedBlocks([block], peer);
    }

    checkReceivedBlocks(blocks, peer) {
        const receivedBlocks = blocks.sort((b1, b2) => b1.index - b2.index);
        const latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
        const latestBlockHeld = this.blockchain.getLastBlock();

        // If the received blockchain is not longer than blockchain. Do nothing.
        if (latestBlockReceived.index <= latestBlockHeld.index) {
            console.info(
                'Received blockchain is not longer than blockchain. Do nothing'
            );
            return false;
        }

        console.info(
            `Blockchain possibly behind. We got: ${
                latestBlockHeld.index
            }, Peer got: ${latestBlockReceived.index}`
        );
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            // We can append the received block to our chain
            console.info('Appending received block to our chain');
            this.blockchain.addBlock(latestBlockReceived);
            // We send the peer to our known peers seeing he gave us a valid block
            this.broadcast(this.sendPeer, peer);
            // We try to add him to our peer list
            this.connectToPeer(peer);
            return true;
        } else if (receivedBlocks.length === 1) {
            // We have to query the chain from our peer
            console.info('Querying chain from our peers');
            this.broadcast(this.getBlocks);
            return null;
        } else {
            // Received blockchain is longer than current blockchain
            console.info(
                'Received blockchain is longer than current blockchain'
            );
            this.blockchain.replaceChain(receivedBlocks);
            return true;
        }
    }
}

module.exports = Node;
