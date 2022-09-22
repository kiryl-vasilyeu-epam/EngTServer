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

const server = require('http').createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const SHEET = 'sheet1';
const spreadsheetId = '1WWNhfxQxo7uodXixlOomxmcFT-FlKsyUB8NFekOjBew';
const keyFile = 'credentials.json';
// const keyFile = '/home/ec2-user/EngTServer/credentials.json';

let auth;
let client;
const getSpreadsheet = async () => {
  try {
    if (!auth || !client) {
      auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
      });
      client = await auth.getClient();
    }

    const googleSheets = google.sheets({ version: 'v4', auth: client });

    const defaultOptions = {
      auth,
      spreadsheetId,
      range: SHEET,
    };

    return { spreadsheets: googleSheets.spreadsheets, defaultOptions };
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
const textFieldValues = new Map();
const ranges = new Map();

const getOnlineUsers = (sheetId) => [...users.entries()]
  .filter(([, data]) => data.sheetId === sheetId)
  .map(([id, { name }]) => ({ id, name }));

const combineRest = ([first, ...rest] = []) => [first, rest.join('')];

io.on('connection', async (socket) => {
  const { spreadsheets, defaultOptions } = await getSpreadsheet();
  const { values: sheet } = spreadsheets;
  const id = uniqueId('client_');
  let userName;
  let isAdmin = false;

  socket.on('registerAdmin', async () => {
    console.log(`registerAdmin ${id}`);

    try {
      isAdmin = true;
      admins.set(id, { socket, name: 'admin' });
      const sheetsResponse = await spreadsheets.get({
        auth, spreadsheetId,
      });
      const lessons = sheetsResponse.data.sheets.map(
        ({ properties: { sheetId, title } }) => {
          ranges.set(`${sheetId}`, title);
          return { sheetId, title };
        },
      );

      socket.emit('loadLessons', JSON.stringify(lessons));
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('changeSheetName', async (data) => {
    console.log(`changeSheetName ${id} ${data}`);

    try {
      const { sheetId, title } = JSON.parse(data);

      await spreadsheets.batchUpdate({
        auth,
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                fields: 'title',
                properties: {
                  sheetId,
                  title,
                },
              },
            },
          ],
        },
      });
      ranges.set(`${sheetId}`, title);

      admins.forEach(({ socket: clSocket }, adminId) => {
        if (adminId !== id) {
          clSocket.emit('lessonUpdated', data);
        }
      });
      users.forEach(({ socket: clSocket }) => {
        clSocket.emit('lessonUpdated', data);
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('deleteSheet', async (sheetId) => {
    console.log(`deleteSheet ${id} ${sheetId}`);

    try {
      await spreadsheets.batchUpdate({
        auth,
        spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteSheet: {
                sheetId,
              },
            },
          ],
        },
      });

      ranges.delete(`${sheetId}`);
      admins.forEach(({ socket: clSocket }, adminId) => {
        if (adminId !== id) {
          clSocket.emit('lessonDeleted', sheetId);
        }
      });
      users.forEach(({ socket: clSocket }) => {
        clSocket.emit('lessonDeleted', sheetId);
      });

      textFieldValues.delete(sheetId);
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('addSheet', async (title) => {
    console.log(`addSheet ${id} ${title}`);

    try {
      const newSheetData = await spreadsheets.batchUpdate({
        auth,
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title,
                },
              },
            },
          ],
        },
      });

      const sheetId = newSheetData.data.replies?.[0].addSheet.properties.sheetId;
      ranges.delete(sheetId, title);

      admins.forEach(({ socket: clSocket }) => {
        clSocket.emit('lessonUpdated', JSON.stringify({ sheetId, title }));
      });
      users.forEach(({ socket: clSocket }) => {
        clSocket.emit('lessonUpdated', JSON.stringify({ sheetId, title }));
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('adminJoinLesson', async (sheetId) => {
    console.log(`adminJoinLesson ${id} ${sheetId}`);

    try {
      const range = ranges.get(sheetId);
      admins.set(id, {
        ...admins.get(id),
        sheetId,
      });

      const getRows = await sheet.get({
        ...defaultOptions,
        range,
      });
      const data = getRows?.data?.values?.[0] || [];
      socket.emit('loadTasks', combineRest(data));

      socket.emit('loadTextValue', textFieldValues.get(sheetId));

      const onlineUsers = getOnlineUsers(sheetId);
      socket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
      socket.emit('loadActiveUsers', JSON.stringify(
        drop(getRows?.data?.values).map((usersData) => combineRest(usersData)),
      ));
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('adminLeaveLesson', async () => {
    console.log(`adminLeaveLesson ${id}`);

    try {
      admins.set(id, {
        ...admins.get(id),
        sheetId: null,
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('updateTasks', async (data) => {
    console.log(`updateTasks ${id}`);

    try {
      const { sheetId } = admins.get(id);
      const range = ranges.get(sheetId);

      const { tasksId, tasks } = JSON.parse(data);
      await sheet.clear({
        ...defaultOptions,
        range,
      });

      const taskData = JSON.stringify(tasks);
      const taskChunks = chunk(taskData, 49999).map((chunkStr) => chunkStr.join(''));
      const pair = [tasksId, ...taskChunks];
      await sheet.append({
        ...defaultOptions,
        range,
        valueInputOption: 'RAW',
        resource: {
          values: [pair],
        },
      });

      const usersAnswers = [];
      textFieldValues.set(sheetId, '');

      users.forEach(async ({ socket: clSocket, sheetId: clSheetId, name }) => {
        if (clSheetId === sheetId) {
          const userAnswer = JSON.stringify({
            userName: name,
            tasks,
          });
          const useAnswerChunk = chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join(''));

          usersAnswers.push([name, userAnswer]);

          await sheet.append({
            ...defaultOptions,
            range,
            valueInputOption: 'RAW',
            resource: {
              values: [[name, ...useAnswerChunk]],
            },
          });
          clSocket.emit('loadUserAnswer', userAnswer);
          clSocket.emit('loadTextValue', '');
        }
      });
      admins.forEach(({ socket: clSocket, sheetId: clSheetId }, adminId) => {
        if (sheetId === clSheetId) {
          if (id !== adminId) {
            clSocket.emit('loadTasks', combineRest(pair));
          }
          clSocket.emit('loadTextValue', '');
          clSocket.emit('loadActiveUsers', JSON.stringify(usersAnswers));
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('textFieldChanged', (value) => {
    console.log(`textFieldChanged ${userName} ${id}`);

    try {
      const { sheetId } = admins.get(id);

      textFieldValues.set(sheetId, value);
      admins.forEach(({ socket: clSocket, sheetId: clSheetId }, userId) => {
        if (id !== userId && clSheetId === sheetId) {
          clSocket.emit('loadTextValue', value);
        }
      });
      users.forEach(({ socket: clSocket, sheetId: clSheetId }) => {
        if (clSheetId === sheetId) {
          clSocket.emit('loadTextValue', value);
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('registerName', async (name) => {
    console.log(`registerName ${id}`);

    try {
      userName = name;
      users.set(id, { socket, name });
      const sheetsResponse = await spreadsheets.get({
        auth, spreadsheetId,
      });
      const lessons = sheetsResponse.data.sheets.map(
        ({ properties: { sheetId, title } }) => {
          ranges.set(`${sheetId}`, title);
          return { sheetId, title };
        },
      );

      socket.emit('loadLessons', JSON.stringify(lessons));
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('userJoinLesson', async (sheetId) => {
    console.log(`userJoinLesson ${id} ${sheetId}`);

    try {
      const range = ranges.get(sheetId);
      users.set(id, {
        ...users.get(id),
        sheetId,
      });

      const getRows = await sheet.get({
        ...defaultOptions,
        range,
      });
      const data = getRows?.data?.values || [];
      const userData = data.find(([name]) => name === userName);

      let userAnswer;
      if (!userData) {
        userAnswer = JSON.stringify({
          userName,
          tasks: JSON.parse(
            combineRest(data[0])[1],
          ),
        });
        const useAnswerChunk = chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join(''));

        await sheet.append({
          ...defaultOptions,
          range,
          valueInputOption: 'RAW',
          resource: {
            values: [[userName, ...useAnswerChunk]],
          },
        });
      } else {
        [, userAnswer] = combineRest(userData);
      }
      socket.emit('loadUserAnswer', userAnswer);

      socket.emit('loadTextValue', textFieldValues.get(sheetId));

      const onlineUsers = getOnlineUsers(sheetId);
      admins.forEach(({ socket: clSocket, sheetId: clSheetId }) => {
        if (sheetId === clSheetId) {
          clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('userLeaveLesson', async (sheetId) => {
    console.log(`userLeaveLesson ${id}`);

    try {
      users.set(id, {
        ...users.get(id),
        sheetId: null,
      });

      const onlineUsers = getOnlineUsers(sheetId);
      admins.forEach(({ socket: clSocket, sheetId: clSheetId }) => {
        if (sheetId === clSheetId) {
          clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('updateUserAnswers', async (userAnswer) => {
    console.log(`updateUserAnswers ${userName}`);

    try {
      const { sheetId } = users.get(id);
      const range = ranges.get(sheetId);

      const getRows = await sheet.get({
        ...defaultOptions,
        range,
      });
      const data = getRows?.data?.values || [];
      const index = data.findIndex(([name]) => name === userName) + 1;

      await sheet.batchUpdate({
        ...defaultOptions,
        range: undefined,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{
            range: `${range}!${index}:${index}`,
            values: [[
              userName,
              ...chunk(userAnswer, 49999).map((chunkStr) => chunkStr.join('')),
            ]],
          }],
        },
      });

      admins.forEach(({ socket: clSocket, sheetId: clSheetId }) => {
        if (clSheetId === sheetId) {
          clSocket.emit('updateActiveUsers', { userName, userAnswer });
        }
      });
    } catch (e) {
      console.log(e);
    }
  });

  socket.on('disconnect', () => {
    console.log(`disconnect ${userName} ${id}`);

    try {
      if (isAdmin) {
        admins.delete(id);
      } else {
        users.delete(id);
        admins.forEach(({ socket: clSocket, sheetId }) => {
          if (sheetId) {
            const onlineUsers = getOnlineUsers(sheetId);
            clSocket.emit('loadOnlineUsers', JSON.stringify(onlineUsers));
          }
        });
      }
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
