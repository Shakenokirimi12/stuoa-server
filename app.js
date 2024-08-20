var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors'); // Import the cors module

var apiRouter = require('./routes/api');
var app = express();
app.disable('etag');
// Enable CORS for all routes
app.use(cors());

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRouter);

app.get('/', function (req, res, next) {
  const filePath = path.join(__dirname, '/adminui/index.html');
  res.sendFile(filePath);  // Send index.html to the client
});

app.use(function (req, res, next) {
  next(createError(404));
});

app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.title = 'Error'; // Set a title for the error page
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

// Set port from environment variable or default to 3000
const port = process.env.PORT || 3030;
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

module.exports = app;
