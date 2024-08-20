var express = require('express');
var router = express.Router();


router.get('/', function (req, res, next) {
  res.sendFile('./public/adminui/index.html');  //クライアントにindex.htmlを返す
});

module.exports = router;