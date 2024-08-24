//& module require zone
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
const readline = require('readline');
//& module require zone

var app = express(); // define app
app.disable('etag'); // Disable cookie holding

// /adminui以下のパスに対してstaticファイルを提供
app.use('/adminui', express.static(path.join(__dirname, ".", "build")));

// /adminui以下の全てのリクエストをindex.htmlにリダイレクト
app.use('/adminui', (req, res, next) => {
    res.sendFile(path.join(__dirname, ".", "build", "index.html"));
});


//& router require zone
var apiRouter = require('./routes/api');
//& router reqire zone

//& view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
//& view engine setup

//& app.use zone
app.use(cors()); // Enable CORS for all routes
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);
//& app.use zone

//& when pathname is not found
app.use(function (req, res, next) {
  next(createError(404));
});
//& when pathname is not found

// Error handling middleware
app.use(function (err, req, res, next) {
  // Set locals, only providing error in development
  res.locals.title = 'Error'; // Set a title for the error page
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // Render the error page
  res.status(err.status || 500);
  res.render('error');
});

// Create interface for input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ask for port number and start server
rl.question('Please enter the port number to start the server: ', (inputPort) => {
  if (!inputPort) {
    console.log('No port number provided. Exiting.');
    rl.close();
    return;
  }

  const port = parseInt(inputPort, 10);

  if (isNaN(port)) {
    console.log('Invalid port number. Exiting.');
    rl.close();
    return;
  }

  app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
  });

  rl.close(); // Close the readline interface
});

module.exports = app;
//& set express setting and start
