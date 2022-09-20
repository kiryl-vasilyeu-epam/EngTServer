/* eslint-disable no-console */
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(express.json());
app.options(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const SHEET = 'sheet1';

const server = require('http').createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});
let auth;
let client;
const getSpreadSheet = async () => {
  try {
    if (!auth || !client) {
      auth = new google.auth.GoogleAuth({
        keyFile: 'credentials.json',
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
      });
      client = await auth.getClient();
    }

    const googleSheets = google.sheets({ version: 'v4', auth: client });
    const spreadsheetId = '1WWNhfxQxo7uodXixlOomxmcFT-FlKsyUB8NFekOjBew';

    const defaultOptions = {
      auth,
      spreadsheetId,
      range: SHEET,
    };

    return { sheet: googleSheets.spreadsheets.values, defaultOptions };
  } catch (e) {
    console.log(e);
    return { };
  }
};

const {
  uniqueId, drop, chunk,
} = require('lodash');

const clients = new Map();
let textFieldValue = '';

const getOnlineUsers = () => [...clients.entries()]
  .map(([id, { name, isAdmin }]) => ({ isAdmin, id, name }));

const combineRest = ([first, ...rest] = []) => [first, rest.join('')];

io.on('connection', async (socket) => {
  const { sheet, defaultOptions } = await getSpreadSheet();
  const id = uniqueId('client_');
  let userName;

  socket.on('registerName', async (name) => {
    try {
      clients.set(id, { name, isAdmin: false, socket });
      userName = name;

      const getRows = await sheet.get(defaultOptions);
      const data = getRows?.data?.values || [];
      if (data.length) {
        const userData = data.find(([username]) => username === name);

        let userAnswer;
        if (!userData) {
          userAnswer = JSON.stringify({
            userName: name,
            tasks: JSON.parse(
              combineRest(data[0])[1],
            ),
          });
          const useAnswerChunk = chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join(''));

          await sheet.append({
            ...defaultOptions,
            valueInputOption: 'RAW',
            resource: {
              values: [[name, ...useAnswerChunk]],
            },
          });
        } else {
          [, userAnswer] = combineRest(userData);
        }
        socket.emit('loadUserAnswer', userAnswer);
      }

      const onlineUsers = getOnlineUsers();
      clients.forEach(({ socket: clSocket, isAdmin }) => {
        if (isAdmin) {
          clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
        }
      });
      socket.emit('loadTextValue', textFieldValue);
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('updateUserAnswers', async (userAnswer) => {
    try {
      const getRows = await sheet.get(defaultOptions);
      const data = getRows?.data?.values || [];
      const index = data.findIndex(([name]) => name === userName) + 1;

      await sheet.batchUpdate({
        ...defaultOptions,
        range: undefined,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{
            range: `${SHEET}!${index}:${index}`,
            values: [[
              userName,
              ...chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join('')),
            ]],
          }],
        },
      });

      clients.forEach(({ socket: clSocket, isAdmin }) => {
        if (isAdmin) {
          clSocket.emit('updateActiveUsers', { userName, userAnswer });
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('registerAdmin', async () => {
    try {
      clients.set(id, { socket, name: 'admin', isAdmin: true });
      const getRows = await sheet.get(defaultOptions);
      const data = getRows?.data?.values?.[0] || [];
      socket.emit('loadTasks', combineRest(data));
      const onlineUsers = getOnlineUsers();
      socket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
      socket.emit('loadActiveUsers', JSON.stringify(
        drop(getRows?.data?.values).map((users) => combineRest(users)),
      ));
      socket.emit('loadTextValue', textFieldValue);
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('updateTasks', async (data) => {
    try {
      const { tasksId, tasks } = JSON.parse(data);
      await sheet.clear(defaultOptions);

      const taskData = JSON.stringify(tasks);
      const taskChunks = chunk(taskData, 49999).map((chunkStr) => chunkStr.join(''));
      const pair = [tasksId, ...taskChunks];
      await sheet.append({
        ...defaultOptions,
        valueInputOption: 'RAW',
        resource: {
          values: [pair],
        },
      });

      clients.forEach(async ({ socket: clSocket, isAdmin, name }, userId) => {
        if (isAdmin && id !== userId) {
          clSocket.emit('loadTasks', combineRest(pair));
        } else if (!isAdmin) {
          const userAnswer = JSON.stringify({
            userName: name,
            tasks,
          });
          const useAnswerChunk = chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join(''));

          await sheet.append({
            ...defaultOptions,
            valueInputOption: 'RAW',
            resource: {
              values: [[name, ...useAnswerChunk]],
            },
          });
          clSocket.emit('loadUserAnswer', userAnswer);
        }
      });
      textFieldValue = '';
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('disconnect', () => {
    try {
      clients.delete(id);
      const onlineUsers = getOnlineUsers();
      clients.forEach(({ socket: clSocket, isAdmin }) => {
        if (isAdmin) {
          clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('textFieldChanged', (value) => {
    try {
      textFieldValue = value;
      clients.forEach(({ socket: clSocket }, userId) => {
        if (id !== userId) {
          clSocket.emit('loadTextValue', value);
        }
      });
    } catch (e) {
      console.log(e);
    }
  });
});

app.get('/', (req, res) => {
  res.send('Nothing to see here');
});

// eslint-disable-next-line no-console
server.listen(8080, () => console.log('running on 8080'));
