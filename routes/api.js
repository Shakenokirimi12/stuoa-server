var db = require('./db');
const fs = require('fs');
const { Client } = require('tplink-smarthome-api');
var express = require('express');
var router = express.Router();
var path = require('path');

router.get('/adminui/errorcheck', function (req, res) {
    let sql = `SELECT * FROM Errors WHERE IsSolved = 0`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.status(200).json(rows);
    });
});

router.post('/adminui/errorsolve', function (req, res) {
    const { ErrorId } = req.body;
    let sql = `UPDATE Errors SET IsSolved = 1 WHERE ErrorId = ?`;

    db.run(sql, [ErrorId], function (err) {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.status(200).send('Error resolved');
    });
});

router.get('/adminui/errorHistory', function (req, res) {
    let sql = `SELECT * FROM Errors`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.status(200).json(rows);
    });

});

router.get('/adminui/roomStatus/:roomCode', function (req, res) {
    const { roomCode } = req.params;
    db.all("SELECT * FROM Rooms WHERE RoomID = ?", [roomCode], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }
        res.json(rows);
    });

});


router.post('/adminui/regChallenge', function (req, res) {
    const { roomID, challengerName, playerCount, difficulty } = req.body;

    if (roomID && challengerName && playerCount != null && difficulty != null) {
        // Start a transaction to ensure data consistency
        db.run('BEGIN TRANSACTION', function (err) {
            if (err) {
                console.error('Error starting transaction', err.message);
                res.status(500).json({ success: false, message: 'Database error' });
                return;
            }

            // Check if the RoomID exists
            const checkRoomSql = `
                SELECT RoomID FROM Rooms WHERE RoomID = ?
            `;
            db.get(checkRoomSql, [roomID], function (err, row) {
                if (err) {
                    console.error('Error checking RoomID', err.message);
                    res.status(500).json({ success: false, message: 'Database error' });
                    db.run('ROLLBACK');
                    return;
                }

                // Determine if there are active challenges for this room
                const checkActiveChallengesSql = `
                    SELECT COUNT(*) AS ActiveCount
                    FROM Challenges
                    WHERE RoomID = ? AND State = 'Playing'
                `;
                db.get(checkActiveChallengesSql, [roomID], function (err, activeCountRow) {
                    if (err) {
                        console.error('Error checking active challenges', err.message);
                        res.status(500).json({ success: false, message: 'Database error' });
                        db.run('ROLLBACK');
                        return;
                    }

                    const hasActiveChallenges = activeCountRow.ActiveCount > 0;
                    const challengeState = hasActiveChallenges ? 'Pending' : 'Playing';

                    if (row) {
                        // Room exists, determine next status
                        const getMaxStatusSql = `
                            SELECT MAX(CAST(Status AS INTEGER)) AS MaxStatus
                            FROM Rooms
                            WHERE RoomID = ?
                        `;
                        db.get(getMaxStatusSql, [roomID], function (err, result) {
                            if (err) {
                                console.error('Error retrieving max status', err.message);
                                res.status(500).json({ success: false, message: 'Database error' });
                                db.run('ROLLBACK');
                                return;
                            }

                            const currentStatus = result.MaxStatus || 0;
                            const nextStatus = (currentStatus + 1).toString();

                            // Add the challenge
                            const addChallengeSql = `
                                INSERT INTO Challenges (GroupId, Difficulty, RoomID, StartTime, State)
                                VALUES (?, ?, ?, ?, ?)
                            `;
                            const addChallengeParams = [
                                require('crypto').randomUUID(), // GroupId generated automatically
                                difficulty,
                                roomID,
                                new Date().toISOString(), // StartTime as ISO string
                                challengeState
                            ];

                            db.run(addChallengeSql, addChallengeParams, function (err) {
                                if (err) {
                                    console.error('Error inserting challenge', err.message);
                                    res.status(500).json({ success: false, message: 'Database error' });
                                    db.run('ROLLBACK');
                                    return;
                                }

                                // Insert a new room entry with the next status
                                const addRoomSql = `
                                    INSERT INTO Rooms (RoomID, ChallengerName, ChallengerId, Difficulty, MemberCount, Status, StartTime)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)
                                `;
                                const addRoomParams = [
                                    roomID,
                                    challengerName,
                                    require('crypto').randomUUID(), // Generate ChallengerId
                                    difficulty,
                                    playerCount,
                                    nextStatus,
                                    new Date().toISOString() // StartTime as ISO string
                                ];

                                db.run(addRoomSql, addRoomParams, function (err) {
                                    if (err) {
                                        console.error('Error inserting room', err.message);
                                        res.status(500).json({ success: false, message: 'Database error' });
                                        db.run('ROLLBACK');
                                        return;
                                    }

                                    db.run('COMMIT', function (err) {
                                        if (err) {
                                            console.error('Error committing transaction', err.message);
                                            res.status(500).json({ success: false, message: 'Database error' });
                                            return;
                                        }

                                        console.log(`Challenge and new room entry successfully added for room ${roomID}`);
                                        res.status(200).json({ success: true, message: 'Challenge and new room entry successfully added' });
                                    });
                                });
                            });
                        });
                    } else {
                        // Room does not exist, add a new room with 'Active' status
                        const addChallengeSql = `
                            INSERT INTO Challenges (GroupId, Difficulty, RoomID, StartTime, State)
                            VALUES (?, ?, ?, ?, ?)
                        `;
                        const addChallengeParams = [
                            require('crypto').randomUUID(), // GroupId generated automatically
                            difficulty,
                            roomID,
                            new Date().toISOString(), // StartTime as ISO string
                            challengeState
                        ];

                        db.run(addChallengeSql, addChallengeParams, function (err) {
                            if (err) {
                                console.error('Error inserting challenge', err.message);
                                res.status(500).json({ success: false, message: 'Database error' });
                                db.run('ROLLBACK');
                                return;
                            }

                            // Insert a new room entry with 'Active' status
                            const addRoomSql = `
                                INSERT INTO Rooms (RoomID, ChallengerName, ChallengerId, Difficulty, MemberCount, Status, StartTime)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `;
                            const addRoomParams = [
                                roomID,
                                challengerName,
                                require('crypto').randomUUID(), // Generate ChallengerId
                                difficulty,
                                playerCount,
                                'Active', // Set status as 'Active'
                                new Date().toISOString() // StartTime as ISO string
                            ];

                            db.run(addRoomSql, addRoomParams, function (err) {
                                if (err) {
                                    console.error('Error inserting room', err.message);
                                    res.status(500).json({ success: false, message: 'Database error' });
                                    db.run('ROLLBACK');
                                    return;
                                }

                                db.run('COMMIT', function (err) {
                                    if (err) {
                                        console.error('Error committing transaction', err.message);
                                        res.status(500).json({ success: false, message: 'Database error' });
                                        return;
                                    }

                                    console.log(`Challenge and new 'Active' room entry successfully added for room ${roomID}`);
                                    res.status(200).json({ success: true, message: 'Challenge and new \'Active\' room entry successfully added' });
                                });
                            });
                        });
                    }
                });
            });
        });
    } else {
        res.status(400).json({ success: false, message: 'Invalid data' });
    }
});





router.delete('/adminui/rooms/delete/:roomID', function (req, res) {
    const { roomID } = req.params;

    if (!roomID) {
        return res.status(400).json({ success: false, message: 'Room ID is required' });
    }

    // Start a transaction to ensure data consistency
    db.run('BEGIN TRANSACTION', function (err) {
        if (err) {
            console.error('Error starting transaction', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        // Delete the room
        const deleteRoomSql = `
            DELETE FROM Rooms WHERE RoomID = ?
        `;
        db.run(deleteRoomSql, [roomID], function (err) {
            if (err) {
                console.error('Error deleting room', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            db.run('COMMIT', function (err) {
                if (err) {
                    console.error('Error committing transaction', err.message);
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                console.log(`Room successfully deleted for room ${roomID}`);
                return res.status(200).json({ success: true, message: 'Room successfully deleted' });
            });
        });
    });
});

// Assuming you have already set up your Express.js app and database connection
router.get('/adminui/rooms/list', function (req, res, next) {
    const sql = 'SELECT * FROM Rooms';

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching rooms', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.status(200).json({ success: true, data: rows });
    });
});

router.put('/adminui/rooms/update/:roomID', function (req, res) {
    const { roomID } = req.params;
    const { challengerName, challengerId, difficulty, memberCount, status, startTime } = req.body;

    if (!roomID || !challengerName || !challengerId || !difficulty || memberCount == null || !status || !startTime) {
        return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    const updateRoomSql = `
        UPDATE Rooms
        SET ChallengerName = ?, ChallengerId = ?, Difficulty = ?, MemberCount = ?, Status = ?, StartTime = ?
        WHERE RoomID = ?
    `;
    const updateRoomParams = [challengerName, challengerId, difficulty, memberCount, status, startTime, roomID];

    db.run(updateRoomSql, updateRoomParams, function (err) {
        if (err) {
            console.error('Error updating room', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.status(200).json({ success: true, message: 'Room successfully updated' });
    });
});


router.get('/client/finish/:roomCode', function (req, res) {
    const { roomCode } = req.params;

    if (!roomCode) {
        return res.status(400).json({ success: false, message: 'Room code is required' });
    }

    // Start a transaction to ensure data consistency
    db.run('BEGIN TRANSACTION', function (err) {
        if (err) {
            console.error('Error starting transaction', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        // Delete the room with the specified RoomID if it is 'Active'
        const deleteActiveRoomSql = `
            DELETE FROM Rooms WHERE RoomID = ? AND Status = 'Active'
        `;
        db.run(deleteActiveRoomSql, [roomCode], function (err) {
            if (err) {
                console.error('Error deleting active room', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            // Update statuses for remaining rooms
            const updateStatusesSql = `
                UPDATE Rooms
                SET Status = CASE
                    WHEN Status = '1' THEN 'Active'
                    WHEN Status != 'Active' THEN CAST(Status AS INTEGER) - 1
                    ELSE Status
                END
                WHERE RoomID = ?
            `;
            db.run(updateStatusesSql, [roomCode], function (err) {
                if (err) {
                    console.error('Error updating statuses', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                // Update Challenges state
                const updateChallengesSql = `
                    UPDATE Challenges
                    SET State = CASE
                        WHEN State = 'Playing' THEN 'Finished'
                        WHEN State = 'Pending' AND (
                            SELECT COUNT(*) FROM Challenges WHERE RoomID = ? AND State = 'Playing'
                        ) = 0 THEN 'Playing'
                        ELSE State
                    END
                    WHERE RoomID = ?
                `;
                db.run(updateChallengesSql, [roomCode, roomCode], function (err) {
                    if (err) {
                        console.error('Error updating challenges state', err.message);
                        db.run('ROLLBACK');
                        return res.status(500).json({ success: false, message: 'Database error' });
                    }

                    db.run('COMMIT', function (err) {
                        if (err) {
                            console.error('Error committing transaction', err.message);
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }

                        console.log(`Room with room code ${roomCode} processed successfully`);
                        return res.status(200).json({ success: true, message: 'Room processed successfully' });
                    });
                });
            });
        });
    });
});




//Functions to get files to use in the game
//start
function getFileList(dir) {
    return fs.readdirSync(dir).map(file => ({
        name: file,
        path: path.join(dir, file),
        isDirectory: fs.statSync(path.join(dir, file)).isDirectory()
    }));
}

router.get('/client/filelist', (req, res) => {
    const dirPath = path.join(__dirname, '../data');
    try {
        const files = getFileList(dirPath);
        res.json(files);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error reading directory');
    }
});
//end
//Functions to get files to use in the game


//Function to get currentrooms' status
//start
router.get('/client/currentroom/:roomCode', function (req, res, next) {
    const { roomCode } = req.params;
    db.all("SELECT * FROM Rooms WHERE RoomID = ? AND Status = ?", [roomCode, "Active"], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }
        res.json(rows);
    });
});

//end
//Function to get currentrooms' status


// /getfile/{filename} endpoint
router.get('/client/getfile/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../data', filename);

    // Prevent directory traversal attacks
    if (!filePath.startsWith(path.join(__dirname, '../data'))) {
        return res.status(403).send('Forbidden');
    }

    // Check if file exists
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            return res.status(404).send('File not found');
        }

        // Send file
        res.sendFile(filePath);
    });
});


router.get('/client/:challengerId/getQuestion/:level', function (req, res, next) {
    const { level } = req.params;
    const { challengerId } = req.params;
    // Initialize the attempt counter
    const attemptCounter = { count: 0 };
    getRandomQuestion(level, challengerId, res, next, attemptCounter);
});

const getRandomQuestion = (level, challengerId, res, next, attemptCounter) => {
    if (attemptCounter.count >= 30) {
        return res.status(500).json({ error: "No question to answer. Please contact support.", code: "CL-GQ-01" });
    }

    attemptCounter.count++;

    db.all("SELECT * FROM Questions WHERE Difficulty = ? ORDER BY RANDOM() LIMIT 1", [level], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }
        if (rows.length > 0) {
            const json = rows[0];  // 1つのレコードをjson変数として取得
            db.all("SELECT * FROM AnsweredQuestions WHERE GroupId = ? AND QuestionId = ?", [challengerId, json.ID], function (err, ansStateRows) {
                if (err) {
                    console.error('Error executing query:', err.message);
                    return next(err);
                }
                if (ansStateRows.length > 0) {
                    if (ansStateRows[0].Result != "correct") {
                        res.json(rows);
                    } else {
                        getRandomQuestion(level, challengerId, res, next, attemptCounter);
                    }
                } else {
                    res.json(rows);
                }
            });
        } else {
            res.status(404).json({ error: "No matching question found" });
        }
    });
};



// POST: Client Error Report
router.post('/client/errorReport', function (req, res) {
    const { error, location } = req.body;

    if (error && location) {
        // Insert the error into the database
        const sql = `
        INSERT INTO Errors (ErrorId, Description, IsSolved, FromWhere, ReportedTime)
        VALUES (?, ?, ?, ?, ?)
      `;
        const params = [
            require('crypto').randomUUID(),  // Generates a unique ErrorId
            error,
            0,  // IsSolved is set to 0 (false)
            location,
            new Date().toISOString({ timeZone: "Asia/Tokyo" })  // Current timestamp
        ];

        db.run(sql, params, function (err) {
            if (err) {
                console.error('Error inserting into database', err.message);
                res.status(500).send('Database error');
                return;
            }

            // Log error to the console in red
            console.log('\x1b[31m%s\x1b[0m', `Error reported: ${error}\nLocation: ${location}`);

            res.status(200).send('Error reported');
        });
    } else {
        res.status(400).send('Invalid data');
    }
});


//出せる問題があるかのチェック
//start
router.get('/client/:challengerId/checkQuestions/:level', function (req, res, next) {
    console.log("Checking available questions.");
    const { level } = req.params;
    const { challengerId } = req.params;

    checkAvailableQuestions(level, challengerId, res, next);
});

const checkAvailableQuestions = (level, challengerId, res, next) => {
    // 各レベルごとの必要な質問数を設定
    let requiredQuestions;
    switch (level) {
        case "1":
        case "2":
            requiredQuestions = 7;
            break;
        case "3":
            requiredQuestions = 6;
            break;
        case "4":
            requiredQuestions = 1;
            break;
        default:
            return res.status(400).json({ error: "Invalid level specified." });
    }

    // クエリを構築して未解答の質問の数をカウント
    const query = `
        SELECT COUNT(*) AS count
        FROM Questions Q
        LEFT JOIN AnsweredQuestions AQ
        ON Q.ID = AQ.QuestionId AND AQ.GroupId = ?
        WHERE Q.Difficulty = ? AND (AQ.Result IS NULL OR AQ.Result != 'correct')
    `;

    db.get(query, [challengerId, level], function (err, row) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }

        // クエリの結果に基づいて条件を確認
        if (row.count >= requiredQuestions) {
            res.json({ available: true });
        } else {
            res.json({ available: false });
        }
    });
};

//end
//出せる問題があるかのチェック



router.get('/plug/:ip/on', async function (req, res, next) {
    const { ip } = req.params;
    const client = new Client();

    try {
        const device = await client.getDevice({ host: ip });
        console.log('Found device:', device.deviceType, device.alias);

        if (device.deviceType === 'plug') {
            console.log(`%cTurning plug named ${device.alias} on`, 'color: green');
            await device.setPowerState(true);
        }

        const result = await device.getSysInfo();
        res.send(result);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Failed to control the device');
    }
});

router.get('/plug/list', async function (req, res, next) {
    const client = new Client();

    let devicelist = [];
    // Look for devices, log to console, and turn them on
    client.startDiscovery().on('device-new', (device) => {
        device.getSysInfo().then(devicelist.add);
    });
});

router.get('/plug/:ip/off', async function (req, res, next) {
    const { ip } = req.params;
    const client = new Client();

    try {
        const device = await client.getDevice({ host: ip });
        console.log('Found device:', device.deviceType, device.alias);

        if (device.deviceType === 'plug') {
            console.log(`%cTurning plug named ${device.alias} off`, 'color: green');
            await device.setPowerState(false);
        }

        const result = await device.getSysInfo();
        res.send(result);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Failed to control the device');
    }
});

router.get('/plug/:ip/switch', async function (req, res, next) {
    const { ip } = req.params;
    const client = new Client();

    try {
        const device = await client.getDevice({ host: ip });
        const devicedata = await device.getSysInfo();
        console.log('Found device:', device.deviceType, device.alias);
        if (device.deviceType === 'plug') {
            if (devicedata.relay_state === 1) {
                device.setPowerState(false).then(() => { console.log(`%cTurning plug named ${device.alias} off`, 'color: green') });
            }
            else {
                device.setPowerState(true).then(() => { console.log(`%cTurning plug named ${device.alias} on`, 'color: green') });
            }
        }
        const result = await device.getSysInfo();
        res.send(result);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Failed to control the device');
    }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

router.get('/plug/:ip/switch/loop/:count', async function (req, res, next) {
    const { ip } = req.params;
    const { count } = req.params;
    const client = new Client();
    try {
        const device = await client.getDevice({ host: ip });
        for (let i = 1; i <= count; i++) {
            const devicedata = await device.getSysInfo();
            if (device.deviceType === 'plug') {
                if (devicedata.relay_state === 1) {
                    await device.setPowerState(false);
                } else {
                    await device.setPowerState(true);
                }
            }
            await sleep(50);
        }
        res.send(`completed switching ${count} times.`);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Failed to control the device');
    }
});


router.get('/alive', function (req, res, next) {
    res.send('Server connection is Okay!');
});

module.exports = router;