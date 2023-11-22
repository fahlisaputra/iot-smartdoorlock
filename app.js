const Firestore = require('@google-cloud/firestore');
const InitializeApp = require('firebase').initializeApp;
const getMessaging = require('firebase').messaging;

// load firebase config
const firebaseConfig = require('./config/firebase_config.json');
const firebaseApp = InitializeApp(firebaseConfig);

const Messaging = getMessaging(firebaseApp);

const db = new Firestore({
	projectId: 'fahli-smartdoorlock',
	keyFilename: 'config/google_authentication.json',
});

const createHash = require('node:crypto').createHash;
const express = require('express');
const WebSocketServer = require('websocket').server;
const http = require('http');
const app = express();
const server = http.createServer(app);

const port = process.env.PORT || 3000;

server.listen(port, () => {
	console.log((new Date()) + ' Server is listening on port ' + port);
});

const websocket = new WebSocketServer({
	httpServer: server,
	autoAcceptConnections: false
});

const generateToken = (length) => {
	let result = '';
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const charactersLength = characters.length;
	let counter = 0;
	while (counter < length) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
		counter += 1;
	}
	return result;
};

const sha256 = (data) => {
	return createHash('sha256').update(data).digest('hex');
};

websocket.on('request', function (request) {
	let token = null;
	let lock = true;
	let cards = '';
	let add_card = false;
	const connection = request.accept(null, request.origin);
	connection.on('message', function (message) {
		if (message.type === 'utf8') {
			if (!token) {
				token = message.utf8Data;
				onlineStatus(token, true);
				setInterval(() => {
					loop();
				}, 1000);
			} else {
				if (message.utf8Data.startsWith('CARD_ADDED')) {
					const card = message.utf8Data.split(' ')[1];
					addCard(token, card, null);
				} else if (message.utf8Data == 'LOCKED') {
					lockDoor(token);
				} else if (message.utf8Data.startsWith('UNLOCKED')) {
					const data = message.utf8Data.split(' ');
					if (data.length > 1) {
						const topic = token;

						const message_notif = {
							notification: {
								title: 'Pintu Terbuka',
								body: 'Pintu terbuka oleh ' + data[1],
							},
							topic: topic
						};

						// Send a message to devices subscribed to the provided topic.
						getMessaging().send(message_notif)
							.then((response) => {
							})
							.catch((error) => {
							});
					}
					unlockDoor(token);

				} else if (message.utf8Data == 'GET_DOOR_LOCK') {
					getDoorLock(token);
				} else if (message.utf8Data == 'SCAN_CARD_TIMEOUT') {
					scanCardTimeout();
				}
			}
		}
	});

	connection.on('close', function (reasonCode, description) {
		onlineStatus(token, false);
	});

	const scanCardTimeout = async () => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		add_card = false;

		await docRef.update({
			add_card: false
		});

		return true;
	}

	const loop = async () => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		if (doc.data().status == 'pairing') {
			completePairing(token);
		}

		let cardData = '';
		doc.data().cards.forEach((card) => {
			cardData += card.card + ' ';
		});

		if (cardData != cards) {
			cards = cardData;
			connection.sendUTF('CARDS ' + cards.trim());
		}

		const lock_status = doc.data().door_status == 'locked';
		if (lock_status != lock) {
			lock = lock_status;
			const lockString = lock ? 'LOCK' : 'UNLOCK';
			connection.sendUTF(lockString);
		}

		lock = doc.data().door_status == 'locked';

		if (doc.data().add_card) {
			if (!add_card) {
				add_card = true;
				connection.sendUTF('ADD_CARD');
			}
		};
	};

	const lockDoor = async (token) => {
		lock = true;
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		await docRef.update({
			door_status: 'locked',
		});

		return true;
	};

	const onlineStatus = async (token, state) => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		await docRef.update({
			online: state,
		});

		return true;
	};

	const unlockDoor = async (token) => {
		lock = false;
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		await docRef.update({
			door_status: 'unlocked',
		});

		return true;
	};

	const completePairing = async (token) => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		await docRef.update({
			pairing_completed_at: new Date(),
			status: 'paired',
		});

		return true;
	};

	const addCard = async (token, card, name) => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		add_card = false;

		await docRef.update({
			cards: [...doc.data().cards, {
				card: card,
				name: name,
			}],
			add_card: false
		});

		return true;
	};

	const getDoorLock = async (token) => {
		const docRef = db.collection('devices').doc(token);
		const doc = await docRef.get();

		if (!doc.exists) {
			return false;
		}

		connection.sendUTF(JSON.stringify({
			type: 'GET_DOOR_LOCK',
			data: doc.data().door_status,
		}));
	};

});


const originIsAllowed = (origin) => {
	return true;
}

app.use(express.json());
app.use(express.urlencoded({
	extended: true
}));

app.post('/api/v1/device/request-pairing', async (req, res) => {
	const { device_id } = req.body;

	if (!device_id) {
		res.status(400);
		return res.send({
			success: false,
			status: 'BAD_REQUEST',
			data: null
		});
	}
	const token = generateToken(10);
	const docRef = db.collection('devices').doc(token);
	await docRef.set({
		device_id: device_id,
		cards: [],
		pairing_request_at: new Date(),
		pairing_completed_at: null,
		status: 'pairing',
		door_status: 'locked',
		online: false,
		add_card: false,
	});

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: {
			token: token
		}
	});
});

app.get('/api/v1/device/:token', async (req, res) => {
	let bearerToken = req.headers.authorization;

	if (!bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	// remove bearer
	if (bearerToken) {
		bearerToken = bearerToken.split(' ');
		if (bearerToken.length > 1) {
			bearerToken = bearerToken[1];
		}
	}

	const { token } = req.params;
	const docRef = db.collection('devices').doc(token);
	const doc = await docRef.get();

	if (!doc.exists) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	if (sha256(doc.data().device_id) !== bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: {
			token: token,
			cards: doc.data().cards,
			status: doc.data().status,
			door_status: doc.data().door_status,
			online: doc.data().online,
			add_card: doc.data().add_card,
		}
	});
});

app.get('/api/v1/device/:token/add-card', async (req, res) => {
	let bearerToken = req.headers.authorization;

	if (!bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	// remove bearer
	if (bearerToken) {
		bearerToken = bearerToken.split(' ');
		if (bearerToken.length > 1) {
			bearerToken = bearerToken[1];
		}
	}

	const { token } = req.params;
	const docRef = db.collection('devices').doc(token);
	const doc = await docRef.get();

	if (!doc.exists) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	if (sha256(doc.data().device_id) !== bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	await docRef.update({
		add_card: true,
	});

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: null
	});
});

// set name for card
app.get('/api/v1/device/:token/card/:card/set-name/:name', async (req, res) => {
	let bearerToken = req.headers.authorization;

	if (!bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	// remove bearer
	if (bearerToken) {
		bearerToken = bearerToken.split(' ');
		if (bearerToken.length > 1) {
			bearerToken = bearerToken[1];
		}
	}

	const { token } = req.params;
	const docRef = db.collection('devices').doc(token);
	const doc = await docRef.get();

	if (!doc.exists) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	if (sha256(doc.data().device_id) !== bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	const { card, name } = req.params;
	const cards = doc.data().cards;
	let cardIndex = -1;
	cards.forEach((item, index) => {
		if (item.card == card) {
			cardIndex = index;
		}
	});

	if (cardIndex == -1) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	cards[cardIndex].name = name;

	await docRef.update({
		cards: cards,
	});

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: null
	});
});

// lock door
app.post('/api/v1/device/:token/lock', async (req, res) => {
	let bearerToken = req.headers.authorization;

	if (!bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	// remove bearer
	if (bearerToken) {
		bearerToken = bearerToken.split(' ');
		if (bearerToken.length > 1) {
			bearerToken = bearerToken[1];
		}
	}

	const { token } = req.params;
	const docRef = db.collection('devices').doc(token);
	const doc = await docRef.get();

	if (!doc.exists) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	if (sha256(doc.data().device_id) !== bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	await docRef.update({
		door_status: 'locked',
	});

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: null
	});
});

// unlock door
app.post('/api/v1/device/:token/unlock', async (req, res) => {
	let bearerToken = req.headers.authorization;

	if (!bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	// remove bearer
	if (bearerToken) {
		bearerToken = bearerToken.split(' ');
		if (bearerToken.length > 1) {
			bearerToken = bearerToken[1];
		}
	}

	const { token } = req.params;
	const docRef = db.collection('devices').doc(token);
	const doc = await docRef.get();

	if (!doc.exists) {
		res.status(404);
		return res.send({
			success: false,
			status: 'NOT_FOUND',
			data: null
		});
	}

	if (sha256(doc.data().device_id) !== bearerToken) {
		res.status(401);
		return res.send({
			success: false,
			status: 'UNAUTHORIZED',
			data: null
		});
	}

	await docRef.update({
		door_status: 'unlocked',
	});

	res.status(200);
	return res.send({
		success: true,
		status: 'OK',
		data: null
	});
});