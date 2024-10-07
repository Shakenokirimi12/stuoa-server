var db = require('./db');
const fs = require('fs');
const { Client } = require('tplink-smarthome-api');
var express = require('express');
var router = express.Router();
var path = require('path');
let hummus = require('hummus')
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)); // 動的インポート

//? pathname to check if error is opening.
router.get('/adminui/errorcheck', function (req, res) {
    let sql = `SELECT * FROM Errors WHERE IsSolved = 0`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        return res.status(200).json(rows);
    });
});


//? pathname to send that error is solved.
router.post('/adminui/errorsolve', function (req, res) {
    const { ErrorId } = req.body;
    let sql = `UPDATE Errors SET IsSolved = 1 WHERE ErrorId = ?`;

    db.run(sql, [ErrorId], function (err) {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        return res.status(200).send('Error resolved');
    });
});


//? pathname to show error history
router.get('/adminui/errorHistory', function (req, res) {
    let sql = `SELECT * FROM Errors`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        return res.status(200).json(rows);
    });

});


//? pathname to get room status of specified room code
router.get('/adminui/roomStatus/:roomCode', function (req, res) {
    const { roomCode } = req.params;
    db.all("SELECT * FROM Rooms WHERE RoomID = ?", [roomCode], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }
        return res.json(rows);
    });

});

router.get('/adminui/getQueueStatus', function (req, res) {
    db.all("SELECT * FROM Rooms WHERE Status = ?", ['1'], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }
        return res.json(rows);
    });
});

router.post('/adminui/setGuidedStatus/:ChallengeId', function (req, res, next) {
    const { ChallengeId } = req.params;
    db.run("UPDATE Rooms SET Status = ?, QueueNumber = ? WHERE ChallengeId = ?",
        ["Guided", null, ChallengeId],
        function (err) {
            if (err) {
                console.error('Error executing query:', err.message);
                return next(err); // Properly handle the error
            }
            return res.json({ message: 'Status updated successfully' });
        });
});

//? pathname to register challange to the server.
//! this pathname is long! 
//! please use code foldering function!
router.post('/adminui/regChallenge/auto', function (req, res) {
    const { GroupName, playerCount, difficulty, dupCheck, queueNumber } = req.body;

    if (GroupName && playerCount != null && difficulty != null && queueNumber != null) {
        db.run('BEGIN TRANSACTION', function (err) {
            if (err) {
                console.error('Error starting transaction', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            // Check if the group name exists
            const checkGroupSql = `SELECT GroupId FROM Groups WHERE Name = ?`;
            db.get(checkGroupSql, [GroupName], function (err, row) {
                if (err) {
                    console.error('Error checking group name', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                if (row) {
                    // Group exists, check for duplicate entry if `dupCheck` is false
                    if (!dupCheck) {
                        db.run('ROLLBACK');
                        return res.status(409).json({ success: false, message: 'Group name already exists. Set dupCheck to true to proceed.' });
                    }
                    console.log(row)
                    const updateGroupSql = `
                        UPDATE Groups SET ChallengesCount = ChallengesCount + 1 WHERE GroupId = ?
                    `;
                    db.run(updateGroupSql, [row.GroupId], function (err) {
                        if (err) {
                            console.error('Error updating group', err.message);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }
                        validateAndAssignRoom(row.GroupId);
                    });
                } else {
                    // Group doesn't exist, create new GroupId
                    const groupId = require('crypto').randomUUID();
                    const insertGroupSql = `
                        INSERT INTO Groups (Name, GroupId, ChallengesCount, PlayerCount, WasCleared, SnackState)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `;
                    db.run(insertGroupSql, [GroupName, groupId, 1, playerCount, 0, 0], function (err) {
                        if (err) {
                            console.error('Error inserting group', err.message);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }
                        validateAndAssignRoom(groupId);
                    });
                }
            });
        });
    } else {
        return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    function validateAndAssignRoom(groupId) {
        // Determine the required number of questions based on the difficulty level
        let requiredQuestions;
        switch (difficulty) {
            case "1":
            case "2":
            case 1:
            case 2:
                requiredQuestions = 7;
                break;
            case "3":
            case 3:
                requiredQuestions = 6;
                break;
            case "4":
            case 4:
                requiredQuestions = 1;
                break;
            default:
                db.run('ROLLBACK');
                return res.status(400).json({ success: false, message: 'Invalid difficulty level' });
        }

        // Check if there are enough questions to start the game
        const query = `
            SELECT COUNT(*) AS count
            FROM Questions Q
            LEFT JOIN AnsweredQuestions AQ ON Q.ID = AQ.QuestionId AND AQ.GroupId = ?
            WHERE Q.Difficulty = ? AND (AQ.Result IS NULL OR AQ.Result NOT IN ('Correct', 'Wrong'))
        `;
        db.get(query, [groupId, difficulty], function (err, row) {
            if (err) {
                console.error('Error executing query:', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            if (row.count >= requiredQuestions) {
                autoAssignRoom(groupId);
            } else {
                db.run('ROLLBACK');
                return res.status(400).json({ success: false, message: 'この難易度でゲームを始めるために必要な問題数が不足しています。難易度を変更してください。' });
            }
        });
    }

    function autoAssignRoom(groupId) {
        // Query the room with the least number of records
        const roomStatusSql = `
            SELECT RoomID, COUNT(*) AS RecordCount
            FROM Rooms
            WHERE RoomID IN ('A', 'B', 'C')
            GROUP BY RoomID
            ORDER BY RecordCount ASC, RoomID ASC
        `;
        db.all(roomStatusSql, [], function (err, rows) {
            if (err) {
                console.error('Error retrieving room status', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            let roomID = assignRoomBasedOnRecords(rows);
            addChallengeAndRoom(groupId, roomID);
        });
    }

    function assignRoomBasedOnRecords(rows) {
        let roomID = 'A'; // Default to Room A
        if (rows.length === 3) {
            roomID = rows[0].RoomID; // The room with the least number of records
        } else {
            const existingRoomIds = rows.map(row => row.RoomID);
            if (!existingRoomIds.includes('A')) roomID = 'A';
            else if (!existingRoomIds.includes('B')) roomID = 'B';
            else if (!existingRoomIds.includes('C')) roomID = 'C';
        }
        return roomID;
    }

    function addChallengeAndRoom(groupId, roomID) {
        const challengeState = 'Registered';
        const ChallengeId = require('crypto').randomUUID();

        const addChallengeSql = `
                INSERT INTO Challenges (GroupId, Difficulty, RoomID, StartTime, State, ChallengeId)
                VALUES (?, ?, ?, ?, ?, ?)
            `;
        const addChallengeParams = [groupId, difficulty, roomID, null, challengeState, ChallengeId];

        db.run(addChallengeSql, addChallengeParams, function (err) {
            if (err) {
                console.error('Error inserting challenge', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            addRoomEntry(groupId, roomID, ChallengeId);
        });
    }

    function addRoomEntry(groupId, roomID, ChallengeId) {
        const getMaxStatusSql = `
            SELECT Status 
            FROM Rooms 
            WHERE RoomID = ? 
            ORDER BY CAST(Status AS INTEGER) DESC
        `;

        db.all(getMaxStatusSql, [roomID], function (err, rows) {
            if (err) {
                console.error('Error retrieving statuses', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            let nextStatus;
            const hasGuidedOrStarted = rows.some(row => row.Status === 'Guided' || row.Status === 'Started');
            const numericStatuses = rows
                .map(row => parseInt(row.Status))
                .filter(status => !isNaN(status));

            if (hasGuidedOrStarted) {
                // If there is a Guided or Started status, start from 2
                nextStatus = numericStatuses.length > 0 ? (Math.max(...numericStatuses) + 1).toString() : '2';
            } else {
                // If no Guided or Started status exists, start from 1
                nextStatus = numericStatuses.length > 0 ? (Math.max(...numericStatuses) + 1).toString() : '1';
            }

            const addRoomSql = `
                INSERT INTO Rooms (RoomID, GroupName, GroupId, Difficulty, MemberCount, Status, RegisteredTime, ChallengeId , QueueNumber)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const addRoomParams = [roomID, GroupName, groupId, difficulty, playerCount, nextStatus, new Date().toISOString(), ChallengeId, queueNumber];

            db.run(addRoomSql, addRoomParams, function (err) {
                if (err) {
                    console.error('Error inserting room', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error : perhaps already queueNumber used?' });
                }

                db.run('COMMIT', function (err) {
                    if (err) {
                        console.error('Error committing transaction', err.message);
                        return res.status(500).json({ success: false, message: 'Database error' });
                    }

                    console.log(`Challenge and new room entry successfully added for room ${roomID}`);
                    return res.status(200).json({ success: true, message: 'Challenge and new room entry successfully added', roomId: roomID });
                });
            });
        });
    }

});



//! the pathname above is long!
//! consider using code foldering function!

//? pathname to reset room status.
router.delete('/adminui/rooms/delete/:ChallengeId', function (req, res) {
    const { ChallengeId } = req.params;

    if (!ChallengeId) {
        return res.status(400).json({ success: false, message: 'Challenge ID is required' });
    }

    // SQL statements
    const deleteRoomSql = 'DELETE FROM Rooms WHERE ChallengeId = ?';
    const deleteChallengeSql = 'DELETE FROM Challenges WHERE ChallengeId = ?';

    // Start a transaction
    db.run('BEGIN TRANSACTION', function (err) {
        if (err) {
            console.error('Error starting transaction', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        // Delete from Rooms
        db.run(deleteRoomSql, [ChallengeId], function (err) {
            if (err) {
                console.error('Error deleting room', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            // Delete from Challenges
            db.run(deleteChallengeSql, [ChallengeId], function (err) {
                if (err) {
                    console.error('Error deleting challenge', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                // Commit the transaction
                db.run('COMMIT', function (err) {
                    if (err) {
                        console.error('Error committing transaction', err.message);
                        return res.status(500).json({ success: false, message: 'Database error' });
                    }
                    console.log(`Room and challenge successfully deleted for ChallengeId ${ChallengeId}`);
                    return res.status(200).json({ success: true, message: 'Room and challenge successfully deleted' });
                });
            });
        });
    });
});

//? Function to download files to use in the game
router.get('/adminui/groups/list', (req, res) => {
    const sql = 'SELECT * FROM Groups';

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching rooms', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, data: rows });
    });
});


router.get('/adminui/groups/:GroupId', (req, res) => {
    let { GroupId } = req.params;
    const sql = 'SELECT * FROM Groups WHERE GroupId = ?';

    db.all(sql, [GroupId], (err, rows) => {
        if (err) {
            console.error('Error fetching Challenges', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, data: rows });
    });
});



router.get('/adminui/groups/:GroupId/getCertificate', (req, res) => {
    const { GroupId } = req.params;
    const getGroupSql = `SELECT * FROM Groups WHERE GroupId = ? AND WasCleared = '1'`;
    db.get(getGroupSql, [GroupId], (err, groupRow) => {
        if (err) {
            console.error('Error fetching Groups', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (!groupRow) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        let { Name } = groupRow;
        console.log(groupRow)
        // Query to get the latest challenge's difficulty for the given GroupId
        const getLatestChallengeSql = `
            SELECT * 
            FROM Challenges 
            WHERE GroupId = ? 
            ORDER BY StartTime DESC 
            LIMIT 1`;

        db.get(getLatestChallengeSql, [GroupId], (err, challengeRow) => {
            if (err) {
                console.error('Error fetching challenge', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            if (!challengeRow) {
                return res.status(404).json({ success: false, message: 'No challenges found for this group' });
            }
            let difficulty = challengeRow.Difficulty;
            switch (difficulty) {
                case 1:
                    difficulty = "初級"
                    break;
                case 2:
                    difficulty = "中級"
                    break;
                case 3:
                    difficulty = "上級"
                    break;
                case 4:
                    difficulty = "超級"
                    break;
            }
            const date = new Date();
            const d = ('0' + date.getDate()).slice(-2);
            const unixTimestamp = Math.floor(date.getTime() / 1000);

            let { ChallengeId } = challengeRow;
            const getClearTimeSql = `
                SELECT * FROM ClearTimes
                WHERE ChallengeId = ?
                ORDER BY ElapsedTime ASC
                LIMIT 1
            `;

            db.get(getClearTimeSql, [ChallengeId], function (err, Challengerow) {
                if (err) {
                    console.error('Error retrieving clear times', err.message, err.stack);
                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                }
                let clearTime = formatElapsedTime(Challengerow.ElapsedTime)


                const templateFilePath = path.join(__dirname, '../pdf/template.pdf');
                const saveDestination = path.join(__dirname, '../pdf/output', `${unixTimestamp}.pdf`);

                try {
                    const pdfWriter = hummus.createWriterToModify(
                        templateFilePath,
                        { modifiedFilePath: saveDestination }
                    );

                    const pageModifier = new hummus.PDFPageModifier(pdfWriter, 0);
                    const font = pdfWriter.getFontForFile(path.join(__dirname, '../pdf/NotoSansJP-Regular.ttf'));

                    pageModifier.startContext().getContext().writeText(
                        Name,
                        130, 570,
                        {
                            font: font,
                            size: 35,
                            colorspace: "gray",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        d,
                        510, 250,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        "クリア難易度:" + difficulty,
                        170, 330,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        "クリアタイム:" + clearTime,
                        150, 290,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.endContext().writePage();
                    pdfWriter.end();
                } catch (ex) {
                    return res.status(404).send('Failed to generate pdf: ' + ex.message);
                }

                // Check if the template file exists
                fs.stat(saveDestination, (err, stats) => {
                    if (err || !stats.isFile()) {
                        return res.status(404).send('File not found');
                    }

                    // Update Group in the database
                    const updateGroupSql = `
                    UPDATE Groups 
                    SET WasCleared = CASE
                      WHEN WasCleared = '1' THEN '2'
                      ELSE WasCleared 
                    END
                    WHERE GroupId = ?`;

                    db.run(updateGroupSql, [GroupId], (err) => {
                        if (err) {
                            console.error('Error updating Groups', err.message);
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }

                        // Send the PDF file as a response
                        return res.status(200).json({ success: true, filename: unixTimestamp + ".pdf" });
                    });
                });
            });
        });
    });
});

router.get('/adminui/groups/:GroupId/getCertificate/re', (req, res) => {
    const { GroupId } = req.params;
    const getGroupSql = `SELECT * FROM Groups WHERE GroupId = ? AND WasCleared = '2'`;
    db.get(getGroupSql, [GroupId], (err, groupRow) => {
        if (err) {
            console.error('Error fetching Groups', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (!groupRow) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        let { Name } = groupRow;
        console.log(groupRow)
        // Query to get the latest challenge's difficulty for the given GroupId
        const getLatestChallengeSql = `
            SELECT * 
            FROM Challenges 
            WHERE GroupId = ? 
            ORDER BY StartTime DESC 
            LIMIT 1`;

        db.get(getLatestChallengeSql, [GroupId], (err, challengeRow) => {
            if (err) {
                console.error('Error fetching challenge', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            if (!challengeRow) {
                return res.status(404).json({ success: false, message: 'No challenges found for this group' });
            }
            let difficulty = challengeRow.Difficulty;
            switch (difficulty) {
                case 1:
                    difficulty = "初級"
                    break;
                case 2:
                    difficulty = "中級"
                    break;
                case 3:
                    difficulty = "上級"
                    break;
                case 4:
                    difficulty = "超級"
                    break;
            }
            const date = new Date();
            const d = ('0' + date.getDate()).slice(-2);
            const unixTimestamp = Math.floor(date.getTime() / 1000);

            let { ChallengeId } = challengeRow;
            const getClearTimeSql = `
                SELECT * FROM ClearTimes
                WHERE ChallengeId = ?
                ORDER BY ElapsedTime ASC
                LIMIT 1
            `;

            db.get(getClearTimeSql, [ChallengeId], function (err, Challengerow) {
                if (err) {
                    console.error('Error retrieving clear times', err.message, err.stack);
                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                }
                let clearTime = formatElapsedTime(Challengerow.ElapsedTime)


                const templateFilePath = path.join(__dirname, '../pdf/template.pdf');
                const saveDestination = path.join(__dirname, '../pdf/output', `${unixTimestamp}.pdf`);

                try {
                    const pdfWriter = hummus.createWriterToModify(
                        templateFilePath,
                        { modifiedFilePath: saveDestination }
                    );

                    const pageModifier = new hummus.PDFPageModifier(pdfWriter, 0);
                    const font = pdfWriter.getFontForFile(path.join(__dirname, '../pdf/NotoSansJP-Regular.ttf'));

                    pageModifier.startContext().getContext().writeText(
                        Name,
                        130, 570,
                        {
                            font: font,
                            size: 35,
                            colorspace: "gray",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        d,
                        510, 250,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        "クリア難易度:" + difficulty,
                        170, 330,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.startContext().getContext().writeText(
                        "クリアタイム:" + clearTime,
                        150, 290,
                        {
                            font: font,
                            size: 30,
                            colorspace: "rgb",
                            color: 0x00
                        }
                    );

                    pageModifier.endContext().writePage();
                    pdfWriter.end();
                } catch (ex) {
                    return res.status(404).send('Failed to generate pdf: ' + ex.message);
                }

                // Check if the template file exists
                fs.stat(saveDestination, (err, stats) => {
                    if (err || !stats.isFile()) {
                        return res.status(404).send('File not found');
                    }

                    // Update Group in the database
                    const updateGroupSql = `
                    UPDATE Groups 
                    SET WasCleared = CASE
                      WHEN WasCleared = '1' THEN '2'
                      ELSE WasCleared 
                    END
                    WHERE GroupId = ?`;

                    db.run(updateGroupSql, [GroupId], (err) => {
                        if (err) {
                            console.error('Error updating Groups', err.message);
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }

                        // Send the PDF file as a response
                        return res.status(200).json({ success: true, filename: unixTimestamp + ".pdf" });
                    });
                });
            });
        });
    });
});

router.get('/adminui/groups/:GroupId/giveSnack', (req, res) => {
    const { GroupId } = req.params;
    // Update Group in the database
    const updateGroupSql = `
    UPDATE Groups 
    SET SnackState = CASE
    WHEN SnackState = '3' THEN '-1'
    WHEN SnackState = '4' THEN '-1'
    WHEN SnackState = '5' THEN '-1'
    ELSE SnackState 
    END
    WHERE GroupId = ?`;

    db.run(updateGroupSql, [GroupId], (err) => {
        if (err) {
            console.error('Error updating Groups', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        // Send the PDF file as a response
        return res.status(200).json({
            success: true,
        });
    });
});

//? Function to download files to use in the game
router.get('/adminui/getpdf/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../pdf/output', filename);
    // Prevent directory traversal attacks
    if (!filePath.startsWith(path.join(__dirname, '../pdf/output'))) {
        return res.status(403).send('Forbidden');
    }

    // Check if file exists
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            return res.status(404).send('File not found');
        }

        // Send file
        return res.sendFile(filePath);
    });
});

//? Pathname to get status.
//! this pathname is often called!
//! please don't make drastic change to this function!
router.get('/adminui/rooms/list', function (req, res, next) {
    const sql = 'SELECT * FROM Rooms';

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching rooms', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, data: rows });
    });
});


router.get('/adminui/stats/Questions', function (req, res, next) {
    const sql = 'SELECT * FROM Questions';

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching rooms', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, data: rows });
    });
});

router.get('/adminui/stats/:QuestionId', function (req, res, next) {
    let { QuestionId } = req.params;
    const sql = 'SELECT * FROM AnsweredQuestions WHERE QuestionId = ?';

    db.all(sql, [QuestionId], (err, rows) => {
        if (err) {
            console.error('Error fetching rooms', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, data: rows });
    });
});

//? Pathname to add answer info.
router.post('/client/answer/register', function (req, res) {
    const { GroupId, QuestionId, Result, ChallengerAnswer } = req.body;

    if (!GroupId || !QuestionId || !Result) {
        return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    const updateAnsweredQuestionSql = `
        INSERT INTO AnsweredQuestions(GroupId, QuestionId, Result, ChallengerAnswer)
        VALUES (?, ?, ?, ?)
    `;
    const updateAnsweredQuestionParams = [GroupId, QuestionId, Result, ChallengerAnswer];

    db.run(updateAnsweredQuestionSql, updateAnsweredQuestionParams, function (err) {
        if (err) {
            console.error('Error updating AnsweredQuestion', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
    });
    if (Result == "Collect") {
        const updateCollectCountSql = `
        UPDATE Questions
        SET CollectCount = CollectCount + 1
        WHERE ID = ?
    `;
        const updateCollectCountParams = [QuestionId];

        db.run(updateCollectCountSql, updateCollectCountParams, function (err) {
            if (err) {
                console.error('Error updating CollectCount', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            return res.status(200).json({ success: true, message: 'CollectCount successfully updated' });
        });
    }
    else {
        const updateWrongCountSql = `
        UPDATE Questions
        SET WrongCount = WrongCount + 1
        WHERE ID = ?
    `;
        const updateWrongCountParams = [QuestionId];

        db.run(updateWrongCountSql, updateWrongCountParams, function (err) {
            if (err) {
                console.error('Error updating WrongCount', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            return res.status(200).json({ success: true, message: 'WrongCount successfully updated' });
        });
    }
});


//? Pathname to end current room challange and move to new one.
router.post('/client/finish/:roomCode', function (req, res) {
    const { roomCode } = req.params;
    const { result } = req.body;

    if (!roomCode) {
        return res.status(400).json({ success: false, message: 'Room code is required' });
    }
    if (!result || (result !== 'Cleared' && result !== 'Failed')) {
        return res.status(400).json({ success: false, message: 'Invalid result value. Must be "Cleared" or "Failed".' });
    }

    // Start a transaction to ensure data consistency
    db.run('BEGIN TRANSACTION', function (err) {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error at 633', error: err.stack });
        }

        // Retrieve ChallengeId using RoomCode
        const getChallengeIdSql = `
            SELECT * FROM Rooms WHERE RoomID = ?
        `;
        db.get(getChallengeIdSql, [roomCode], function (err, row) {
            if (err || !row) {
                db.run('ROLLBACK');
                return res.status(err ? 500 : 404).json({ success: false, message: err ? 'Database error at 644' : 'Room not found' });
            }

            const { ChallengeId, GroupId, Difficulty, GroupName } = row;

            // Delete the room with the specified RoomCode if it is 'Started'
            const deleteActiveRoomSql = `
                DELETE FROM Rooms WHERE RoomID = ? AND Status = 'Started'
            `;
            db.run(deleteActiveRoomSql, [roomCode], function (err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                }

                // Update the corresponding Challenge
                const updateChallengeSql = `
                    UPDATE Challenges SET State = ? WHERE ChallengeId = ?
                `;
                db.run(updateChallengeSql, [result, ChallengeId], function (err) {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                    }

                    // Update statuses for remaining rooms
                    const updateStatusesSql = `
                        UPDATE Rooms SET Status = CAST(Status AS INTEGER) - 1 WHERE RoomID = ?
                    `;
                    db.run(updateStatusesSql, [roomCode], function (err) {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                        }

                        if (result === "Cleared") {
                            const SnackCount = [3, 4, 5][Difficulty - 1] || 0; // Adjust based on difficulty

                            // Update WasCleared and SnackState in the Groups table
                            const updateClearStatusesSql = `
                                UPDATE Groups SET WasCleared = CASE WHEN WasCleared = '0' THEN '1' ELSE WasCleared END,
                                SnackState = CASE WHEN SnackState = '0' THEN ? ELSE SnackState END WHERE GroupId = ?
                            `;
                            db.run(updateClearStatusesSql, [SnackCount, GroupId], function (err) {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                }

                                // Calculate elapsed time and insert it into ClearTimes
                                const getChallengeSql = `
                                    SELECT StartTime FROM Challenges WHERE ChallengeId = ?
                                `;
                                db.get(getChallengeSql, [ChallengeId], function (err, challengeRow) {
                                    if (err || !challengeRow) {
                                        db.run('ROLLBACK');
                                        return res.status(err ? 500 : 404).json({ success: false, message: err ? 'Database error' : 'Challenge not found' });
                                    }

                                    const { StartTime } = challengeRow;
                                    const currentTime = new Date();
                                    const startDate = new Date(StartTime);
                                    const diffSeconds = Math.floor((currentTime - startDate) / 1000);

                                    const updateClearTimeSql = `
                                        INSERT INTO ClearTimes (ElapsedTime, ChallengeId, Difficulty, GroupName)
                                        VALUES (?, ?, ?, ?);
                                    `;
                                    db.run(updateClearTimeSql, [diffSeconds, ChallengeId, Difficulty, GroupName], function (err) {
                                        if (err) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                        }

                                        db.run('COMMIT', function (err) {
                                            if (err) {
                                                return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                            }

                                            console.log(`Room with room code ${roomCode} and corresponding challenge processed successfully`);
                                            return res.status(200).json({ success: true, message: 'Room and challenge processed successfully' });
                                        });
                                    });
                                });
                            });
                        } else {
                            // Commit transaction for 'Failed' result
                            db.run('COMMIT', function (err) {
                                if (err) {
                                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                }

                                console.log(`Room with room code ${roomCode} and corresponding challenge processed successfully`);
                                return res.status(200).json({ success: true, message: 'Room and challenge processed successfully' });
                            });
                        }
                    });
                });
            });
        });
    });
});



//? Functions to get file list to use in the game
//& start
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
        return res.json(files);
    } catch (err) {
        console.error(err);
        return res.status(500).send('Error reading directory');
    }
});
//& end
//? Functions to get file list to use in the game


//? Function to download files to use in the game
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
        return res.sendFile(filePath);
    });
});


//? Function to get currentrooms' status
//& start
router.get('/client/startGame/:roomCode', function (req, res) {
    const { roomCode } = req.params;
    db.get("SELECT * FROM Rooms WHERE RoomID = ? AND Status = ?", [roomCode, "Guided"], function (err, row) {
        if (err) {
            console.error('Error executing select query:', err.message);
            return res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }

        // 部屋が見つからなかった場合
        if (!row) {
            return res.status(200).json({ message: "Room error: perhaps not started?", errorCode: "not-registered" });
        }

        db.run(`UPDATE Challenges SET StartTime = ?, State = 'Started' WHERE ChallengeId = ? AND StartTime IS NULL AND State = 'Registered'`, [new Date().toISOString(), row.ChallengeId], function (err) {
            if (err) {
                StartTime
                console.error('Error executing update query:', err.message);
                return res.status(500).json({ error: 'サーバーエラーが発生しました' });
            }
        });

        // 部屋が見つかった場合、Statusを"Started"に更新
        db.run("UPDATE Rooms SET Status = ? WHERE RoomID = ? AND Status = ?", ["Started", roomCode, "Guided"], function (err) {
            if (err) {
                console.error('Error executing update query:', err.message);
                return res.status(500).json({ error: 'サーバーエラーが発生しました' });
            }

            // 更新が完了したら、部屋の情報を返す
            return res.status(200).json(row);
        });
    });
});

//& end
//? Function to get currentrooms' status

//? get Question for specified challanger in specified level.
router.get('/client/:GroupId/getQuestion/:level', function (req, res, next) {
    const { level, GroupId } = req.params;
    // Initialize the attempt counter
    getRandomQuestion(level, GroupId, res, next, 0);
});

const getRandomQuestion = (level, GroupId, res, next, attemptCounter = 0) => {
    const maxAttempts = 10; // Limit to avoid infinite recursion

    if (attemptCounter >= maxAttempts) {
        return res.status(404).json({ error: "No available questions after multiple attempts." });
    }

    db.all("SELECT * FROM Questions WHERE Difficulty = ? ORDER BY RANDOM() LIMIT 1", [level], function (err, rows) {
        if (err) {
            console.error('Error executing query:', err.message);
            return next(err);
        }

        if (rows.length > 0) {
            const json = rows[0];
            db.all("SELECT * FROM AnsweredQuestions WHERE GroupID = ? AND QuestionID = ?", [GroupId, json.ID], function (err, ansStateRows) {
                if (err) {
                    console.error('Error executing query:', err.message);
                    return next(err);
                }

                if (ansStateRows.length > 0) {
                    // Question has already been answered, attempt again
                    console.log(`Question ${json.ID} already answered. Retrying... Attempt: ${attemptCounter + 1}`);
                    getRandomQuestion(level, GroupId, res, next, attemptCounter + 1);
                } else {
                    // Found a valid question
                    console.log(rows);
                    return res.json(rows);
                }
            });
        } else {
            return res.status(404).json({ error: "No matching question found" });
        }
    });
};

router.get('/client/getQuestionById/:questionid', function (req, res, next) {
    const { questionid } = req.params;
    const getQuestionByIdSql = `
            SELECT * FROM Questions WHERE ID = ?
        `;
    db.get(getQuestionByIdSql, [questionid], function (err, row) {
        if (err) {
            console.error('Error retrieving Question By id', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (row) {
            return res.status(200).json(row);
        }
    })
});


//? POST: Endpoint for Client Error Report
router.post('/client/errorReport', function (req, res) {
    const { error, location } = req.body;

    if (error && location) {
        // データベースにエラーを挿入
        const sql = `
        INSERT INTO Errors (ErrorId, Description, IsSolved, FromWhere, ReportedTime)
        VALUES (?, ?, ?, ?, ?)
      `;
        const params = [
            crypto.randomUUID(),  // 一意のErrorIdを生成
            error,
            0,  // IsSolvedは0 (未解決)に設定
            location,
            new Date().toISOString({ timeZone: "Asia/Tokyo" })  // 現在のタイムスタンプ
        ];

        db.run(sql, params, function (err) {
            if (err) {
                console.error('Error inserting into database', err.message);
                return res.status(500).send('Database error');
            }

            // コンソールに赤色でエラーを表示
            console.log('\x1b[31m%s\x1b[0m', `Error reported: ${error}\nLocation: ${location}`);

            // エラーデータを外部サーバーに送信
            sendErrorToExternalServer({ error, location })
                .then(() => {
                    // 成功時のレスポンス
                    return res.status(200).send('Error reported and sent to external server');
                })
                .catch((fetchError) => {
                    // fetchリクエストが失敗してもエラーデータはDBに保存されている
                    console.error('Failed to send error to external server:', fetchError.message);
                    return res.status(200).send('Error reported but failed to send to external server');
                });
        });
    } else {
        return res.status(400).send('Invalid data');
    }
});


// エラーデータを外部サーバーに送信する非同期関数
async function sendErrorToExternalServer({ error, location }) {
    const url = 'https://stuoa-warning.ken20051205.workers.dev/'; // エラー報告を送る外部サーバーのURLを指定

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({  // JSON形式でデータを送信
                message: "error: " + error + "\r\n" + "場所: " + location + "\r\nTime: " + new Date().toISOString()
            })
        });

        if (!response.ok) {
            throw new Error(`Server responded with status ${response.status}: ${response.statusText}`);
        }

        console.log('Error successfully sent to external server.');
    } catch (error) {
        console.error('Error sending to external server:', error.message);
        throw error; // fetchエラーが発生した場合は呼び出し元でキャッチされる
    }
}



//? endpoint to turn on the specified plug.
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
        return res.send(result);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).send('Failed to control the device');
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
        return res.send(result);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).send('Failed to control the device');
    }
});


//? endpoint to switch the power state of the specified plug.
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
        return res.send(result);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).send('Failed to control the device');
    }
});


//? endpoint to flush the plug.
//! DO NOT USE REGULARY!
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
            await sleep(1000);
        }
        return res.send(`completed switching ${count} times.`);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).send('Failed to control the device');
    }
});
//! DO NOT USE REGULARY!

//? endpoint to get rankings.
router.get('/cleartimes', function (req, res) {
    const { difficulty } = req.query;

    if (!difficulty) {
        return res.status(400).json({ success: false, message: 'Difficulty parameter is required' });
    }

    const getClearTimesSql = `
        SELECT * FROM ClearTimes
        WHERE Difficulty = ?
        ORDER BY ElapsedTime ASC
    `;

    db.all(getClearTimesSql, [difficulty], function (err, rows) {
        if (err) {
            console.error('Error retrieving clear times', err.message, err.stack);
            return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
        }

        return res.status(200).json({ success: true, data: rows });
    });
});

const formatElapsedTime = (elapsedTime) => {
    const minutes = Math.floor(elapsedTime / 60);
    const seconds = elapsedTime % 60;
    return `${minutes}分 ${seconds}秒`;
};


//? endpoint to check server availability.
router.get('/alive', function (req, res, next) {
    return res.send('Server connection is Okay!');
});


module.exports = router;