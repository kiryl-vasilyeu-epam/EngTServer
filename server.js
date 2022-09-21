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
// const SHEET = 'sheet2';

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
        // keyFile: 'credentials.json',
        keyFile: '/home/ec2-user/EngTServer/credentials.json',
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

const users = new Map();
const admins = new Map();
let textFieldValue = '';

const getOnlineUsers = () => [...users.entries()]
  .map(([id, { name }]) => ({ id, name }));

const combineRest = ([first, ...rest] = []) => [first, rest.join('')];

io.on('connection', async (socket) => {
  const { sheet, defaultOptions } = await getSpreadSheet();
  const id = uniqueId('client_');
  let userName;
  let isAdmin = false;

  socket.on('registerName', async (name) => {
    try {
      users.set(id, { name, socket });
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
          admins.forEach(({ socket: clSocket }) => {
            clSocket.emit('updateActiveUsers', { userName, userAnswer });
          });
        } else {
          [, userAnswer] = combineRest(userData);
        }
        socket.emit('loadUserAnswer', userAnswer);
      }

      const onlineUsers = getOnlineUsers();
      admins.forEach(({ socket: clSocket }) => {
        clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
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

      admins.forEach(({ socket: clSocket }) => {
        clSocket.emit('updateActiveUsers', { userName, userAnswer });
      });
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('registerAdmin', async () => {
    try {
      isAdmin = true;
      admins.set(id, { socket, name: 'admin' });
      const getRows = await sheet.get(defaultOptions);
      const data = getRows?.data?.values?.[0] || [];
      socket.emit('loadTasks', combineRest(data));
      const onlineUsers = getOnlineUsers();
      socket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
      socket.emit('loadActiveUsers', JSON.stringify(
        drop(getRows?.data?.values).map((usersData) => combineRest(usersData)),
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

      const usersAnswers = [];

      users.forEach(async ({ socket: clSocket, name }) => {
        const userAnswer = JSON.stringify({
          userName: name,
          tasks,
        });
        const useAnswerChunk = chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join(''));

        usersAnswers.push([name, userAnswer]);

        await sheet.append({
          ...defaultOptions,
          valueInputOption: 'RAW',
          resource: {
            values: [[name, ...useAnswerChunk]],
          },
        });
        clSocket.emit('loadUserAnswer', userAnswer);
      });

      admins.forEach(({ socket: clSocket }, adminId) => {
        if (id !== adminId) {
          clSocket.emit('loadTasks', combineRest(pair));
        }
        clSocket.emit('loadActiveUsers', JSON.stringify(usersAnswers));
      });

      textFieldValue = '';
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('disconnect', () => {
    try {
      if (isAdmin) {
        admins.delete(id);
      } else {
        users.delete(id);
        const onlineUsers = getOnlineUsers();
        admins.forEach(({ socket: clSocket }) => {
          clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
        });
      }
    } catch (e) {
      console.log(e);
    }
  });

  // ! ------------------------------------------------------------------------------------

  socket.on('textFieldChanged', (value) => {
    try {
      textFieldValue = value;
      users.forEach(({ socket: clSocket }, userId) => {
        if (id !== userId) {
          clSocket.emit('loadTextValue', value);
        }
      });
      admins.forEach(({ socket: clSocket }, userId) => {
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
