var sqlite3 = require('sqlite3').verbose();
var fs = require('fs');

const dbPath = 'database/stuoa-db.db';
let db;

if (fs.existsSync(dbPath)) {
  console.log('Database file exists.');
  // データベースに接続
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
    } else {
      console.log('Connected to the database.');
    }
  });
} else {
  console.error('Database file does not exist.');
  console.error('Process can not proceed anymore.');
  process.exit(-1);
}

module.exports = db;
