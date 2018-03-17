let stream = require('stream');
let timers = require('timers');
let debug = require('debug')('net');

function createServer(...args) {
	throw new Error('Cannot create server in a browser');
}

function createConnection(...args) {
	args = normalizeConnectArgs(args);
	let s = new Socket(args[0]);
	return s.connect(...args);
}

function toNumber(x) {
	return (x = Number(x)) >= 0 ? x : false;
}

function isPipeName(s) {
	return typeof s === 'string' && toNumber(s) === false;
}

// Returns an array [options] or [options, cb]
// It is the same as the argument of Socket.prototype.connect().
function normalizeConnectArgs(args) {
	let options = {};
	if (typeof args[0] == 'object' && args[0] !== null) {
		// connect(options, [cb])
		options = args[0];
	} else if (isPipeName(args[0])) {
		// connect(path, [cb]);
		options.path = args[0];
	} else {
		// connect(port, [host], [cb])
		options.port = args[0];
		if (typeof args[1] === 'string') {
			options.host = args[1];
		} else {
			options.host = 'localhost';
		}
	}
	let cb = args[args.length - 1];
	return (typeof cb == 'function') ? [options, cb] : [options];
}


class Socket extends stream.Duplex {

	constructor(options) {
		if (typeof options === 'number')
			options = { fd: options };
		else if (!options)
			options = {};
		
		super(options);

		this.bufferSize = undefined;

		this.remoteAddress = null;
		this.remoteFamily = null;
		this.remotePort = null;

		this.localAddress = null;
		this.localPort = null;

		this.bytesRead = 0;
		this.bytesWritten = 0;

		this.connecting = false;
		this._host = null;
		
		this.readable = this.writable = false;
		this._writableState.decodeStrings = false;
		this.allowHalfOpen = options && options.allowHalfOpen || false;
	}

	
	setTimeout(msecs, callback) {
		if (msecs > 0 && isFinite(msecs)) {
			timers.enroll(this, msecs);
			if (callback) {
				this.once('timeout', callback);
			}
		} else if (msecs === 0) {
			timers.unenroll(this);
			if (callback) {
				this.removeListener('timeout', callback);
			}
		}	
	}
	
	_onTimeout() {
		debug('_onTimeout');
		this.emit('timeout');
	}
	
	setNoDelay() {}
	setKeepAlive(setting, msecs) {}
	
	address() {
		return {
			address: this.remoteAddress,
			port: this.remotePort,
			family: this.remoteFamily
		};	
	}


	listen() {
		throw new Error('Cannot listen in a browser');
	}

	connect(options, cb) {
		if (options === null || typeof options !== 'object') {
			// Old API:
			// connect(port, [host], [cb])
			// connect(path, [cb]);
			return this.connect(normalizeConnectArgs([options, cb]));
		}
		if (options.path) {
			throw new Error('options.path not supported in the browser');
		}

		this.connecting = true;
		this.writable = true;
		this._host = this.remoteAddress = options.host;
		this.remotePort = options.port;
		this.remoteFamily = 'IPv4'; // TODO: fix

		if (this._ws) {
			process.nextTick(() => {
				if(cb) cb();
			});
			return;
		}

		let url = (options.protocol || 'ws://') + (options.host || 'localhost') + ':' + (options.port || 80) + (options.wspath || '/');
		this._ws = new WebSocket(url);
		this._ws.addEventListener('open', () => {
			this.connecting = false;
			this.readable = true;

			this.emit('connect');
			this.read(0);
		});
		this._ws.addEventListener('error', (e) => {
			// `e` doesn't contain anything useful (https://developer.mozilla.org/en/docs/WebSockets/Writing_WebSocket_client_applications#Connection_errors)
			this.emit('error', 'An error occured while connecting the WebSocket');
		});
		this._ws.addEventListener('message', (e) => {
			let contents = e.data;
 			let gotBuffer = (buffer) => {
				this.bytesRead += buffer.length;
				this.push(buffer);
			};

			if (typeof contents == 'string') {
				let buffer = new Buffer(contents);
				gotBuffer(buffer);
			} else if (window.Blob && contents instanceof Blob) {
				let fileReader = new FileReader();
				fileReader.addEventListener('load', (e) => {
					let buf = fileReader.result;
					let arr = new Uint8Array(buf);
					gotBuffer(new Buffer(arr));
				});
				fileReader.readAsArrayBuffer(contents);
			} else {
				console.warn('Cannot read TCP stream: unsupported message type', contents);
			}
		});
		this._ws.addEventListener('close', () => {
			if (this.readyState == 'open') {
				this.destroy();
			}
		});

		if (cb) {
			this.on('connect', cb);
		}
		
		return this;
	}

	_read() {}

	_write(data, encoding, cb) {
		// If we are still connecting, then buffer this for later.
		// The Writable logic will buffer up any more writes while
		// waiting for this one to be done.
		if (this.connecting) {
			this._pendingData = data;
			this._pendingEncoding = encoding;
			this.once('connect', () => {
				this._write(data, encoding, cb);
			});
			return;
		}
		this._pendingData = null;
		this._pendingEncoding = '';

		if (encoding == 'binary' && typeof data == 'string') {
			// TODO: maybe apply this for all string inputs?
			// Setting encoding is very important for binary data - otherwise the data gets modified
			data = new Buffer(data, encoding);
		}

		// Send the data
		this._ws.send(data);

		process.nextTick(() => {
			//console.log('[tcp] sent: ', data.toString(), data.length);
			this.bytesWritten += data.length;
			if (cb) cb();
		});
	}
	
	write(chunk, encoding, cb) {
		if (typeof chunk !== 'string' && !(chunk instanceof Buffer))
			throw new TypeError('invalid data');
		return super.write(chunk, encoding, cb);
	}
	
	end(data, encoding) {
		super.end(data, encoding);
		this.writable = false;

		if (this._ws) {
			this._ws.close();
		}

		// just in case we're waiting for an EOF.
		if (this.readable && !this._readableState.endEmitted)
			this.read(0);
		else
			this.maybeDestroy();
	}
	
	destroySoon() {
		if (this.writable)
			this.end();
		if (this._writableState.finished)
			this.destroy();
		else
			this.once('finish', this.destroy);
	}
	
	maybeDestroy() {
		if (this.readyState == 'closed' && !this._writableState.length) {
			socket.destroy();
		}
	}

	destroy(exception) {
		debug('destroy', exception);
		
		if (this.destroyed) {
			return;
		}

		this.connecting = false;
		this.readable = this.writable = false;

		timers.unenroll(this);

		debug('close');

		this.destroyed = true;
	}
	
}

Object.defineProperty(Socket.prototype, 'readyState', {
	get: function() {
		if (this.connecting) {
			return 'opening';
		} else if (this.readable && this.writable) {
			return 'open';
		} else if (this.readable && !this.writable) {
			return 'readOnly';
		} else if (!this.readable && this.writable) {
			return 'writeOnly';
		} else {
			return 'closed';
		}
	}
});

function isIP(input) {
	if (isIPv4(input)) {
		return 4;
	} else if (isIPv6(input)) {
		return 6;
	} else {
		return 0;
	}
};

function isIPv4(input) {
	return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(input);
};

function isIPv6(input) {
	return /^(([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))$/.test(input);
};

module.exports = {
        createServer,
        createConnection,
        connect: createConnection,
	Socket,
	Stream: Socket,
	isIP,
	isIPv4,
	isIPv6
};
