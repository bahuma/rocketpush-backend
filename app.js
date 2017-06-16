const admin = require('firebase-admin');
const fetch = require('node-fetch');
const moment = require('moment');
const CronJob = require('cron').CronJob;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FB_DATABASE_URL,
});

const db = admin.database();

function getTokensForShow(showName, type) {
  console.log('getTokensForShow', showName, type);

  return new Promise((resolve, reject) => {
    const showRef = db.ref('shows');

    showRef.orderByChild('label').equalTo(showName).once('value', snapshot => {
      const val = snapshot.val();
      if (!val) {
        resolve([]);
        return;
      }

      const abos = val[Object.keys(val)[0]].abos;

      let userIds = [];

      for (let key in abos) {
        if (abos.hasOwnProperty(key)) {
          let abo = abos[key];

          if (abo[type]) {
            userIds.push(key);
          }
        }
      }

      let proms = [];

      userIds.forEach(userid => {
        proms.push(new Promise((resolve, reject) => {
          const userRef = db.ref(`users/${userid}/notificationtokens`);
          userRef.once('value', (snapshot) => {
            let val = snapshot.val();
            if (val) {
              let tokens = Object.keys(val).map(key => val[key]);
              resolve(tokens);
            } else {
              console.log('no val');
              resolve([]);
            }
          });
        }));
      });

      Promise.all(proms).then(results => {
        let tokens = [];

        results.forEach(result => {
          result.forEach(token => {
            tokens.push(token);
          });
        });

        resolve(tokens);
      });
    });
  });
}

function sendNotification(tokens, title, body, link) {
  console.log('sendNotification', tokens, title, body, link);

  return new Promise((resolve, reject) => {
    if (tokens.length === 0) {
      resolve([])
    }

    const payload = {
      notification: {
        title: title,
        body: body,
        icon: 'https://rocketpush.de/images/icon-192x192.png',
        click_action: link,
      },
    };

    admin.messaging().sendToDevice(tokens, payload).then(response => {
      let tokensToRemove = [];

      // For each message check if there was an error
      response.results.forEach((result, index) => {
        const error = result.error;
        if (error) {
          console.log('Faliure sending notification to', tokens[index], error);

          if (error.code === 'messaging/invalid-registration-token' ||
              error.code === 'messaging/registration-token-not-registered') {
            tokensToRemove.push(tokens[index]);
          }
        }
      });

      resolve(tokensToRemove);
    });
  });
}

function findUsersAndTokenId(tokens) {
  return new Promise((resolve, reject) => {
    let result = {};

    const userRef = db.ref('users');

    userRef.once('value', snapshot => {
      const users = snapshot.val();

      for(let userKey in users) {
        if (users.hasOwnProperty(userKey)) {
          let user = users[userKey];

          if (user.notificationtokens) {

            for (let tokenKey in user.notificationtokens) {
              if (user.notificationtokens.hasOwnProperty(tokenKey)) {
                tokens.forEach(token => {
                  if (user.notificationtokens[tokenKey] === token) {
                    result[userKey] = tokenKey;
                  }
                });
              }
            }
          }
        }
      }

      resolve(result);
    });
  });
}

function getCurrentPlan() {
  console.log('getCurrentPlan');
  return fetch('http://api.rbtv.rodney.io/api/1.0/schedule/schedule_linear.json')
  // return fetch('http://dev.bahuma.io/test.json')
    .then(response => response.json());
}

function getNextItem(schedule) {
  console.log('getNextItem');
  let nextItem = null;

  schedule.forEach(entry => {
    if (nextItem === null && moment(entry.timeStart) > moment()) {
      nextItem = entry;
    }
  });

  console.log('nextItem ist', nextItem);

  return nextItem;
}

function shouldNotify(item) {
  console.log('check if should notify', item.id);
  return new Promise((resolve, reject) => {
    // Differenz zur naechsten sendung in minuten
    let diff = moment(item.timeStart).diff(moment()) / 1000 / 60;
    console.log(`Nächste Sendung startet in ${diff}`);

    // Wenn nächste Sendung in unter 10 Minuten beginnt
    if (diff < 10) {
      console.log('Nächste Sendung startet in unter 10 Minuten');
      resolve(true);
      return;

      // Wenn Benachrichtigung über diese Sendung noch nicht gesendet wurde
      db.ref(`notifications/sent/${item.id}`).once('value', snapshot => {
        console.log(snapshot.val())
        if (snapshot.val() === null) {
          console.log('Benachrichtigung wurde noch nicht gesendet');
          resolve(true);
          return;
        } else {
          console.log('Benachrichtigung wurde bereits gesendet');
          resolve(false);
          return;
        }
      })
    } else {
      resolve(false);
    }
  })
}

function setItemNotified(item) {
  console.log('setItemNotified', item.id);
  return db.ref(`notifications/sent/${item.id}`).set(true);
}

function doesShowExist(showName) {
  return new Promise((resolve, reject) => {
    const showRef = db.ref('shows');
    showRef.orderByChild('label').equalTo(showName).once('value', snapshot => {
      let val = snapshot.val();

      resolve({
        showName: showName,
        exists: !!val
      });
    })
  })
}

function getUsersToNotifyAboutNewShows() {
  return db.ref('users').orderByChild('notifynewshows').equalTo(true).once('value');
}

function addNewShows(schedule) {
  console.log('addNewShows');

  let shows = [];
  schedule.forEach(item => {
    if (shows.indexOf(item.show) === -1) {
      shows.push(item.show);
    }
  });

  let proms = [];

  shows.forEach(show => {
    proms.push(doesShowExist(show));
  });

  return Promise.all(proms)
    .then(results => {
      let proms = [];
      let showsRef = db.ref('shows');

      results.forEach(result => {
        if (!result.exists) {
          console.log('Add new show', result.showName);

          proms.push(showsRef.push({label: result.showName}));
          proms.push(getUsersToNotifyAboutNewShows().then(snapshot => {
            let users = snapshot.val();

            let tokens = [];

            for (let key in users) {
              if (users.hasOwnProperty(key)) {
                let usertokens = users[key].notificationtokens;

                for (let tokenKey in usertokens) {
                  if (usertokens.hasOwnProperty(tokenKey)) {
                    tokens.push(usertokens[tokenKey])
                  }
                }
              }
            }

            return sendNotification(tokens,`Neue Show: ${result.showName}`, 'Möchtest du sie abonnieren?', 'https://rocketpush.de');
          }))
        }
      });

      return Promise.all(proms);
    });
}

function check() {
  console.log('--------------- checkSchedule --------------', moment());

  let nextItem = null;
  let schedule = null;

  getCurrentPlan().then(data => {
    schedule = data.schedule;

    return addNewShows(schedule);
  })
    .then(() => {
      nextItem = getNextItem(schedule);

      return shouldNotify(nextItem);
    })
    .then(shouldNotify => {
      if (shouldNotify) {
        console.log('Es sollte Benachrichtigt werden');

        let type = false;
        let typeText = "";

        switch (nextItem.type) {
          case "live":
            type = 'live';
            typeText = 'Live';
            break;
          case "premiere":
            type = 'premiere';
            typeText = 'Premiere';
            break;
          case "":
            type = "replay";
            typeText = "Wiederholung"
            break;
        }

        if (!type) {
          console.error('type could not be detected:', type);
          return false;
        }

        setItemNotified(nextItem).catch(e => console.log(e));

        getTokensForShow(nextItem.show, type)
          .then(tokens => {
            return sendNotification(tokens, `${typeText}: ${nextItem.title}`, nextItem.topic, `http://www.rocketbeans.tv/?utm_source=${encodeURIComponent('https://rocketpush.de')}`);
          })
          .then(tokensToRemove => {
            console.log(`${tokensToRemove.length} Tokens sind nicht mehr registriert. Diese werden jetzt gelöscht.`);
            return findUsersAndTokenId(tokensToRemove);
          })
          .then(usersAndTokenIds => {
            let proms = [];

            for (let userId in usersAndTokenIds) {
              if (usersAndTokenIds.hasOwnProperty(userId)) {
                proms.push(db.ref(`users/${userId}/notificationtokens/${usersAndTokenIds[userId]}`).remove());
              }
            }

            return Promise.all(proms);
          })
          .then(() => {
            console.log('check abgeschlossen');
          })
      } else {
        console.log('Es soll nicht benachrichtigt werden. Check beendet.');
      }
    });
}

check();
let job = new CronJob('0 */10 * * * *', check, null, true, 'Europe/Berlin');
