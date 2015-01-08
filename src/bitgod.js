// Copyright 2014 BitGo, Inc.  All Rights Reserved.
//

var ArgumentParser = require('argparse').ArgumentParser;
var bitgo = require('bitgo');
var rpc = require('json-rpc2');
var Q = require('q');
var fs = require('fs');
var _ = require('lodash');
_.string = require('underscore.string');

var BitGoD = function () {
};

BitGoD.prototype.getArgs = function() {
  var parser = new ArgumentParser({
    version: '0.1',
    addHelp:true,
    description: 'BitGoD'
  });

  parser.addArgument(
    ['-prod'], {
      action: 'storeTrue',
      help: 'Use prod network (default is testnet)'
  });

  parser.addArgument(
    ['-rpcbind'], {
      help: 'Bind to given address to listen for JSON-RPC connections (default: localhost)',
      defaultValue: 'localhost'
  });

  parser.addArgument(
    ['-rpcport'], {
      help: 'Listen for JSON-RPC connections on RPCPORT (default: 9332 or testnet: 19332)'
  });

  parser.addArgument(
    ['-proxyhost'], {
      help: 'Host for proxied bitcoind JSON-RPC',
      defaultValue: 'localhost'
  });

  parser.addArgument(
    ['-proxyport'], {
      help: 'Port for proxied bitcoind JSON-RPC (default: 8332 or testnet: 18332)',
      defaultValue: 18332
  });

  parser.addArgument(
    ['-proxyuser'], {
      help: 'Username for proxied bitcoind JSON-RPC',
      defaultValue: 'bitcoinrpc'
  });

  parser.addArgument(
    ['-proxypassword'], {
      help: 'Password for proxied bitcoind JSON-RPC',
  });

  parser.addArgument(
    ['-proxy'], {
      action: 'storeTrue',
      help: 'Proxy to bitcoind JSON-RPC backend for non-wallet commands'
  });

  return parser.parseArgs();
};

BitGoD.prototype.setupProxy = function() {
  var self = this;

  if (this.client) {
    throw new Error('proxy already set up');
  }

  var commandGroups = {
    blockchain: 'getbestblockhash getblock getblockchaininfo getblockcount getblockhash getchaintips getdifficulty getmempoolinfo getrawmempool gettxout gettxoutsetinfo verifychain',
    control: 'getinfo help',
    mining: 'getmininginfo getnetworkhashps prioritisetransaction submitblock',
    network: 'addnode getaddednodeinfo getconnectioncount getnettotals getnetworkinfo getpeerinfo ping',
    tx: 'createrawtransaction decoderawtransaction decodescript getrawtransaction sendrawtransaction signrawtransaction',
    util: 'createmultisig estimatefee estimatepriority validateaddress verifymessage'
  };

  var proxyPort = this.args.proxyport || (this.bitgo.network === 'prod' ? 8332 : 18332);

  this.client = rpc.Client.$create(
    proxyPort,
    this.args.proxyhost,
    this.args.proxyuser,
    this.args.proxypassword
  );

  var proxyCommand = function(cmd) {
    self.server.expose(cmd, function(args, opt, callback) {
      self.client.call(cmd, args, callback);
    });
  };

  // Proxy all the commands
  for (var group in commandGroups) {
    commandGroups[group].split(' ').forEach(proxyCommand);
  }
};

BitGoD.prototype.ensureWallet = function() {
  if (!this.wallet) {
    throw new Error('Not connected to BitGo wallet');
  }
};

BitGoD.prototype.getKeychain = function() {
  if (!this.keychain) {
    throw new Error('No keychain');
  }
  return this.keychain;
};

BitGoD.prototype.getMinConfirms = function(minConfirms) {
  if (typeof(minConfirms) == 'undefined') {
    minConfirms = 1;
  }
  minConfirms = Number(minConfirms);
  if (minConfirms !== 0 && minConfirms !== 1) {
    throw new Error('unsupported minconf value');
  }
  return minConfirms;
};

BitGoD.prototype.getMaxTransactions = function(maxTransactions) {
  if (typeof(maxTranscations) == 'undefined') {
    maxTransactions = 1;
  }
  maxTransactions = Number(maxTransactions);
  if (maxTransactions !== 0 && maxTransactions !== 1) {
    throw new Error('unsupported maxtransactions value');
  }
  return maxTransactions;
};

BitGoD.prototype.toBTC = function(satoshis) {
  return (satoshis / 1e8);
};

BitGoD.prototype.getNumber = function(val, defaultValue) {
  if (typeof(val) === 'undefined') {
    return defaultValue;
  }
  var result = Number(val);
  if (isNaN(result)) {
    throw this.error('value is not a number', -1);
  }
  return result;
};

BitGoD.prototype.getInteger = function(val, defaultValue) {
  var number = this.getNumber(val, defaultValue);
  var integer = parseInt(number);
  if (integer != number) {
    throw this.error('value is type real, expected int', -1);
  }
  return integer;
};

BitGoD.prototype.error = function(message, code) {
  if (!code) {
    throw new Error(message);
  }
  var MyError = rpc.Error.AbstractError.$define('MyError', {code: code});
  return new MyError(message);
};

BitGoD.prototype.getWallet = function(id) {
  id = id || this.wallet.id();
  return this.bitgo.wallets().get({id: id});
};

BitGoD.prototype.handleSetToken = function(token) {
  var self = this;
  this.bitgo._token = token;
  return this.bitgo.me()
  .then(function(user) {
    self.bitgo._user = user;
    return 'Authenticated as BitGo user: ' + user.username;
  });
};

BitGoD.prototype.handleSetWallet = function(walletId) {
  var self = this;
  if (this.wallet && this.wallet.id() === walletId) {
    return 'Set wallet: ' + walletId;
  }
  return this.getWallet(walletId)
  .then(function(wallet) {
    self.wallet = wallet;
    return 'Set wallet: ' + wallet.id();
  });
};

BitGoD.prototype.handleUnlock = function(otp) {
  return this.bitgo.unlock({otp: otp})
  .then(function() {
    return 'Unlocked';
  });
};

BitGoD.prototype.handleSetKeychain = function(xprv) {
  var self = this;

  this.ensureWallet();
  if (xprv === '') {
    delete this.keychain;
    return 'Keychain removed';
  }
  var bip32;
  try {
    bip32 = new bitgo.BIP32(xprv);
    this.ensureWallet();
    if (bip32.extended_private_key_string() !== xprv) {
      throw new Error();
    }
  } catch (err) {
    throw new Error('Invalid keychain xprv');
  }
  var xpub = bip32.extended_public_key_string();

  return this.bitgo.keychains().get({xpub: xpub})
  .then(function(keychain) {
    keychain.xprv = xprv;
    self.keychain = keychain;
    return 'Keychain set';
  });
};

BitGoD.prototype.handleGetNewAddress = function(returnJSON) {
  this.ensureWallet();
  return this.wallet.createAddress()
  .then(function(address) {
    if (returnJSON == 'json') {
      return address;
    }
    return address.address;
  });
};

BitGoD.prototype.handleGetBalance = function(account, minConfirms) {
  this.ensureWallet();
  var self = this;
  minConfirms = this.getMinConfirms(minConfirms);
  if (account && account != '*') {
    return this.toBTC(0);
  }
  return this.getWallet()
  .then(function(wallet) {
    switch (minConfirms) {
      // TODO: determine the correct thing to do here
      case 0:
        return self.toBTC(wallet.balance());
      case 1:
        return self.toBTC(wallet.confirmedBalance());
    }
  });
};

BitGoD.prototype.handleListAccounts = function(minConfirms) {
  return this.handleGetBalance('', minConfirms)
  .then(function(balance) {
    return {
      "": balance
    };
  });
};

BitGoD.prototype.handleListUnspent = function(minConfirms, maxConfirms, addresses) {
  this.ensureWallet();
  var self = this;
  minConfirms = this.getNumber(minConfirms, 1);
  maxConfirms = this.getNumber(maxConfirms, 9999999);

  return this.wallet.unspents()
  .then(function(unspents) {
    return unspents.map(function(u) {
      return {
        txid: u.tx_hash,
        vout: u.tx_output_n,
        address: u.address,
        account: '',
        scriptPubKey: u.script,
        redeemScript: u.redeemScript,
        amount: self.toBTC(u.value),
        confirmations: u.confirmations
      };
    })
    .filter(function(u) {
      return (u.confirmations >= minConfirms && u.confirmations <= maxConfirms);
    });
  });
};

BitGoD.prototype.handleListTransactions = function(account, count, from) {
  this.ensureWallet();
  var self = this;
  maxTransactions = this.getMaxTransactions();
  count = this.getInteger(count, 10);
  from = this.getInteger(from, 0);
  if (count < 0) {
    throw this.error('Negative count', -8);
  }
  if (from < 0) {
    throw this.error('Negative from', -8);
  }

  var txList = [];
  var outputList = [];

  return this.wallet.transactions()
  .then(function(result) {
    result.transactions.every(function(tx) {

      for (var index = 0; index < tx.entries.length; ++index) {
        if (tx.entries[index].account == self.wallet.id()) {
          tx.value = tx.entries[index].value;
          break;
        }
      }

      tx.outputs.forEach(function(output) {
        // Skip the output if it's an overall spend, but we have a positive output to us,
        // or if it's an overall receive, and there's a positive output elsewhere.
        // This should be the change.
        if (tx.value < 0 && output.isMine ||
            tx.value > 0 && !output.isMine) {
          return;
        }
        output.netValue = output.isMine ? output.value : -output.value;
        var record = {
          account: '',
          address: output.account,
          category:  output.isMine ? 'receive' : 'send',
          amount: self.toBTC(output.netValue),
          vout: output.vout,
          confirmations: tx.confirmations,
          blockhash: tx.blockhash,
          // blockindex: 0,
          // blocktime: '',
          txid: tx.id,
          time: new Date(tx.date).getTime() / 1000,
          timereceived: new Date(tx.date).getTime() / 1000,
        };
        if (tx.value < 0) {
          record.fee = self.toBTC(-tx.fee);
        }
        outputList.push(record);
      });
      return (outputList.length < count + from);
    });

    return outputList
    .slice(from, count + from)
    .sort(function(a, b) {
      return b.confirmations - a.confirmations;
    });
  });
};

BitGoD.prototype.handleSendToAddress = function(address, btcAmount, comment) {
  this.ensureWallet();
  var self = this;
  var satoshis = Math.floor(Number(btcAmount) * 1e8);

  return this.getWallet()
  .then(function(wallet) {
    var recipients = {};
    recipients[address] = satoshis;
    return self.wallet.createTransaction({
      recipients: recipients,
      keychain: self.getKeychain()
    });
  })
  .then(function(tx) {
    return self.wallet.sendTransaction({
      tx: tx.tx,
      message: comment
    });
  })
  .then(function(result) {
    return result.hash;
  })
  .catch(function(err) {
    var message = err.message || err;

    if (message === 'Insufficient funds') {
      throw self.error('Insufficient funds', -6);
    }
    if (message.indexOf('invalid bitcoin address') !== '-1') {
      throw self.error('Invalid Bitcoin address', -5);
    }
    if (message.indexOf('invalid amount') !== '-1') {
      throw this.error('Invalid amount', -3);
    }
  });
};

BitGoD.prototype.handleSendMany = function(recipientsInput, comment) {
  this.ensureWallet();
  var self = this;
  var recipients;

  try {
    recipients = JSON.parse(recipientsInput);
  } catch (err) {
    throw self.error('Error parsing JSON:'+recipientsInput, -1);
  }

  Object.keys(recipients).forEach(function(destinationAddress) {
    recipients[destinationAddress] = Math.floor(Number(recipients[destinationAddress]) * 1e8);
  });

  return this.getWallet()
  .then(function(wallet) {
    return self.wallet.createTransaction({
      recipients: recipients,
      keychain: self.getKeychain()
    });
  })
  .then(function(tx) {
    return self.wallet.sendTransaction({
      tx: tx.tx,
      message: comment
    });
  })
  .then(function(result) {
    return result.hash;
  })
  .catch(function(err) {
    var message = err.message || err;

    if (message === 'Insufficient funds') {
      throw self.error('Insufficient funds', -6);
    }
    if (message.indexOf('invalid bitcoin address') !== '-1') {
      throw self.error(message, -5);
    }
    if (message.indexOf('invalid amount') !== '-1') {
      throw self.error(message, -3);
    }
  });
};

BitGoD.prototype.expose = function(name, method) {
  var self = this;
  this.server.expose(name, function(args, opt, callback) {
    return Q().then(function() {
      return method.apply(self, args);
    })
    .nodeify(callback);
  });
};

BitGoD.prototype.run = function() {
  this.args = this.getArgs();
  var self = this;

  // Configure bitcoin network (prod/testnet)
  var network = 'testnet';
  if (process.env.BITGO_NETWORK === 'prod' || self.args.prod) {
    network = 'prod';
  }
  bitgo.setNetwork(network);
  self.bitgo = new bitgo.BitGo({
    useProduction: network === 'prod'
  });

  // Set up RPC server
  self.server = rpc.Server.$create({
    'websocket': true,
    'headers': {
      'Access-Control-Allow-Origin': '*',
    }
  });

  // Proxy bitcoind
  if (self.args.proxy) {
    self.setupProxy();
  }

  // BitGo-handled bitcoind methods
  self.expose('getnewaddress', self.handleGetNewAddress);
  self.expose('getbalance', self.handleGetBalance);
  self.expose('listaccounts', self.handleListAccounts);
  self.expose('listunspent', self.handleListUnspent);
  self.expose('sendtoaddress', self.handleSendToAddress);
  self.expose('listtransactions', self.handleListTransactions);
  self.expose('sendmany', self.handleSendMany);

  // BitGo-specific methods
  self.expose('settoken', self.handleSetToken);
  self.expose('setkeychain', self.handleSetKeychain);
  self.expose('setwallet', self.handleSetWallet);
  self.expose('unlock', self.handleUnlock);

  // Listen
  var port = self.args.rpcport || (self.bitgo.network === 'prod' ? 9332 : 19332);
  self.server.listen(port, self.args.rpcbind);
  console.log('JSON-RPC server active on ' + self.args.rpcbind + ':' + port);
};

exports = module.exports = BitGoD;