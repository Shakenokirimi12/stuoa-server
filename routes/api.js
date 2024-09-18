var db = require('./db');
const fs = require('fs');
const { Client } = require('tplink-smarthome-api');
var express = require('express');
var router = express.Router();
var path = require('path');
let hummus = require('hummus')

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

//? pathname to register challange to the server.
//! this pathname is long! 
//! please use code foldering function!
router.post('/adminui/regChallenge', function (req, res) {
    const { GroupName, playerCount, difficulty, roomID, dupCheck } = req.body;

    if (GroupName && playerCount != null && difficulty != null && roomID) {
        db.run('BEGIN TRANSACTION', function (err) {
            if (err) {
                console.error('Error starting transaction', err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            // Check if the group name exists
            const checkGroupSql = `
                SELECT GroupId FROM Groups WHERE Name = ?
            `;
            db.get(checkGroupSql, [GroupName], function (err, row) {
                if (err) {
                    console.error('Error checking group name', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                const addChallengeAndRoom = (groupId) => {
                    // Determine challenge state
                    const checkActiveChallengesSql = `
                        SELECT COUNT(*) AS ActiveCount
                        FROM Challenges
                        WHERE RoomID = ? AND State = 'Playing'
                    `;
                    db.get(checkActiveChallengesSql, [roomID], function (err, activeCountRow) {
                        if (err) {
                            console.error('Error checking active challenges', err.message);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }

                        const hasActiveChallenges = activeCountRow.ActiveCount > 0;
                        const challengeState = hasActiveChallenges ? 'Pending' : 'Playing';
                        const ChallengeId = require('crypto').randomUUID();

                        const addChallengeSql = `
                            INSERT INTO Challenges (GroupId, Difficulty, RoomID, StartTime, State,ChallengeId)
                            VALUES (?, ?, ?, ?, ?, ?)
                        `;
                        const addChallengeParams = [
                            groupId,
                            difficulty,
                            roomID,
                            new Date().toISOString(), // StartTime as ISO string
                            challengeState,
                            ChallengeId
                        ];

                        db.run(addChallengeSql, addChallengeParams, function (err) {
                            if (err) {
                                console.error('Error inserting challenge', err.message);
                                db.run('ROLLBACK');
                                return res.status(500).json({ success: false, message: 'Database error' });
                            }

                            // Insert a new room entry
                            const getMaxStatusSql = `
                                SELECT MAX(CAST(Status AS INTEGER)) AS MaxStatus
                                FROM Rooms
                                WHERE RoomID = ?
                            `;
                            db.get(getMaxStatusSql, [roomID], function (err, result) {
                                if (err) {
                                    console.error('Error retrieving max status', err.message);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, message: 'Database error' });
                                }

                                const currentStatus = result.MaxStatus || 0;
                                const nextStatus = (currentStatus + 1).toString();

                                const addRoomSql = `
                                    INSERT INTO Rooms (RoomID, GroupName, GroupId, Difficulty, MemberCount, Status, StartTime ,ChallengeId)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                `;
                                const addRoomParams = [
                                    roomID,
                                    GroupName,
                                    groupId,
                                    difficulty,
                                    playerCount,
                                    nextStatus,
                                    new Date().toISOString(), // StartTime as ISO string
                                    ChallengeId
                                ];

                                db.run(addRoomSql, addRoomParams, function (err) {
                                    if (err) {
                                        console.error('Error inserting room', err.message);
                                        db.run('ROLLBACK');
                                        return res.status(500).json({ success: false, message: 'Database error' });
                                    }

                                    db.run('COMMIT', function (err) {
                                        if (err) {
                                            console.error('Error committing transaction', err.message);
                                            return res.status(500).json({ success: false, message: 'Database error' });
                                        }

                                        console.log(`Challenge and new room entry successfully added for room ${roomID}`);
                                        return res.status(200).json({ success: true, message: 'Challenge and new room entry successfully added' });
                                    });
                                });
                            });
                        });
                    });
                };

                if (row) {
                    if (!dupCheck) {
                        // Group name exists and dupCheck is not true, send a warning
                        db.run('ROLLBACK');
                        return res.status(409).json({ success: false, message: 'Group name already exists. Set dupCheck to true to proceed.' });
                    }

                    // Use the existing GroupId
                    addChallengeAndRoom(row.GroupId);
                } else {
                    // Group name does not exist, generate a new GroupId
                    const groupId = require('crypto').randomUUID();

                    const insertGroupSql = `
                        INSERT INTO Groups (Name, GroupId, ChallengesCount, PlayerCount, WasCleared , SnackState)
                        VALUES (?, ?, ?, ?, ?,?)
                    `;
                    db.run(insertGroupSql, [GroupName, groupId, 1, playerCount, 0, 0], function (err) {
                        if (err) {
                            console.error('Error inserting group', err.message);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error' });
                        }

                        // Proceed to add challenge and room
                        addChallengeAndRoom(groupId);
                    });
                }
            });
        });
    } else {
        return res.status(400).json({ success: false, message: 'Invalid data' });
    }
});
//! the pathname above is long!
//! consider using code foldering function!

//? pathname to register challange to the server.
//! this pathname is long! 
//! please use code foldering function!
router.post('/adminui/regChallenge/auto', function (req, res) {
    const { GroupName, playerCount, difficulty, dupCheck } = req.body;

    if (GroupName && playerCount != null && difficulty != null) {
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
                    validateAndAssignRoom(row.GroupId);
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
        const checkActiveChallengesSql = `
            SELECT COUNT(*) AS ActiveCount
            FROM Challenges
            WHERE RoomID = ? AND State = 'Playing'
        `;
        db.get(checkActiveChallengesSql, [roomID], function (err, activeCountRow) {
            if (err) {
                console.error('Error checking active challenges', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            const hasActiveChallenges = activeCountRow.ActiveCount > 0;
            const challengeState = hasActiveChallenges ? 'Pending' : 'Playing';
            const ChallengeId = require('crypto').randomUUID();

            const addChallengeSql = `
                INSERT INTO Challenges (GroupId, Difficulty, RoomID, StartTime, State, ChallengeId)
                VALUES (?, ?, ?, ?, ?, ?)
            `;
            const addChallengeParams = [groupId, difficulty, roomID, new Date().toISOString(), challengeState, ChallengeId];

            db.run(addChallengeSql, addChallengeParams, function (err) {
                if (err) {
                    console.error('Error inserting challenge', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                addRoomEntry(groupId, roomID, ChallengeId);
            });
        });
    }

    function addRoomEntry(groupId, roomID, ChallengeId) {
        const getMaxStatusSql = `SELECT MAX(CAST(Status AS INTEGER)) AS MaxStatus FROM Rooms WHERE RoomID = ?`;
        db.get(getMaxStatusSql, [roomID], function (err, result) {
            if (err) {
                console.error('Error retrieving max status', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            const currentStatus = result.MaxStatus || 0;
            const nextStatus = (currentStatus + 1).toString();

            const addRoomSql = `
                INSERT INTO Rooms (RoomID, GroupName, GroupId, Difficulty, MemberCount, Status, StartTime, ChallengeId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const addRoomParams = [roomID, GroupName, groupId, difficulty, playerCount, nextStatus, new Date().toISOString(), ChallengeId];

            db.run(addRoomSql, addRoomParams, function (err) {
                if (err) {
                    console.error('Error inserting room', err.message);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error' });
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

    db.get(getGroupSql, [GroupId], (err, row) => {
        if (err) {
            console.error('Error fetching Groups', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (!row) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }

        // Query to get the latest challenge's difficulty for the given GroupId
        const getLatestChallengeSql = `
            SELECT Difficulty 
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
            const templateFilePath = path.join(__dirname, '../pdf/template.pdf');
            const saveDestination = path.join(__dirname, '../pdf/output', `${unixTimestamp}.pdf`);

            let { Name } = row;

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


router.get('/adminui/groups/:GroupId/getCertificate/re', (req, res) => {
    const { GroupId } = req.params;
    const getGroupSql = `SELECT * FROM Groups WHERE GroupId = ? AND WasCleared = '2'`;

    db.get(getGroupSql, [GroupId], (err, row) => {
        if (err) {
            console.error('Error fetching Groups', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (!row) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }

        // Query to get the latest challenge's difficulty for the given GroupId
        const getLatestChallengeSql = `
            SELECT Difficulty 
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
            const templateFilePath = path.join(__dirname, '../pdf/template.pdf');
            const saveDestination = path.join(__dirname, '../pdf/output', `${unixTimestamp}.pdf`);

            let { Name } = row;

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

//? Pathname to update challanger info.
router.put('/adminui/rooms/update/:ChallengeId', function (req, res) {
    const { ChallengeId } = req.params;
    const { difficulty, memberCount, status, startTime } = req.body;

    if (!ChallengeId || !difficulty || memberCount == null || !status || !startTime) {
        return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    const updateRoomSql = `
        UPDATE Rooms
        SET Difficulty = ?, MemberCount = ?, Status = ?, StartTime = ?
        WHERE ChallengeId = ?
    `;
    const updateRoomParams = [difficulty, memberCount, status, startTime, ChallengeId];

    db.run(updateRoomSql, updateRoomParams, function (err) {
        if (err) {
            console.error('Error updating room', err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.status(200).json({ success: true, message: 'Room successfully updated' });
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
            console.error('Error starting transaction', err.message, err.stack);
            return res.status(500).json({ success: false, message: 'Database error at 633', error: err.stack });
        }

        // Retrieve ChallengeId using RoomCode
        const getChallengeIdSql = `
            SELECT * FROM Rooms WHERE RoomID = ?
        `;
        db.get(getChallengeIdSql, [roomCode], function (err, row) {
            if (err) {
                console.error('Error retrieving ChallengeId', err.message, err.stack);
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Database error at 644', error: err.stack });
            }

            if (!row) {
                db.run('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Room not found' });
            }

            const { ChallengeId, GroupId, Difficulty } = row;

            // Delete the room with the specified RoomCode if it is 'Started'
            const deleteActiveRoomSql = `
                DELETE FROM Rooms WHERE RoomID = ? AND Status = 'Started'
            `;
            db.run(deleteActiveRoomSql, [roomCode], function (err) {
                if (err) {
                    console.error('Error deleting active room', err.message, err.stack);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                }

                // Update the corresponding Challenge
                const updateChallengeSql = `
                    UPDATE Challenges
                    SET State = ?
                    WHERE ChallengeId = ?
                `;
                db.run(updateChallengeSql, [result, ChallengeId], function (err) {
                    if (err) {
                        console.error('Error updating challenge', err.message, err.stack);
                        db.run('ROLLBACK');
                        return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                    }

                    // Update statuses for remaining rooms
                    const updateStatusesSql = `
                        UPDATE Rooms
                        SET Status = CAST(Status AS INTEGER) - 1
                        WHERE RoomID = ?
                    `;
                    db.run(updateStatusesSql, [roomCode], function (err) {
                        if (err) {
                            console.error('Error updating statuses', err.message, err.stack);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                        }

                        if (result === "Cleared") {
                            let SnackCount;
                            if (Difficulty === 1 || Difficulty === 2) {
                                SnackCount = 3;
                            } else if (Difficulty === 3) {
                                SnackCount = 4;
                            } else if (Difficulty === 4) {
                                SnackCount = 5;
                            }

                            // Update WasCleared and SnackState in the Groups table
                            const updateClearStatusesSql = `
                                UPDATE Groups
                                SET WasCleared = CASE
                                    WHEN WasCleared = '0' THEN '1'
                                    ELSE WasCleared
                                END,
                                SnackState = CASE
                                    WHEN SnackState = '0' THEN ?
                                    ELSE SnackState
                                END
                                WHERE GroupId = ?
                            `;
                            db.run(updateClearStatusesSql, [SnackCount, GroupId], function (err) {
                                if (err) {
                                    console.error('Error updating clear statuses', err.message, err.stack);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                }

                                // Commit transaction
                                db.run('COMMIT', function (err) {
                                    if (err) {
                                        console.error('Error committing transaction', err.message, err.stack);
                                        db.run('ROLLBACK');
                                        return res.status(500).json({ success: false, message: 'Database error', error: err.stack });
                                    }

                                    console.log(`Room with room code ${roomCode} and corresponding challenge processed successfully`);
                                    return res.status(200).json({ success: true, message: 'Room and challenge processed successfully' });
                                });
                            });
                        } else {
                            // Commit transaction for 'Failed' result
                            db.run('COMMIT', function (err) {
                                if (err) {
                                    console.error('Error committing transaction', err.message, err.stack);
                                    db.run('ROLLBACK');
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
    db.get("SELECT * FROM Rooms WHERE RoomID = ? AND Status = ?", [roomCode, "1"], function (err, row) {
        if (err) {
            console.error('Error executing select query:', err.message);
            return res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }

        // 部屋が見つからなかった場合
        if (!row) {
            return res.status(200).json({ message: "Room error: perhaps not started?", errorCode: "not-registered" });
        }

        // 部屋が見つかった場合、Statusを"Started"に更新
        db.run("UPDATE Rooms SET Status = ? WHERE RoomID = ? AND Status = 1", ["Started", roomCode], function (err) {
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
                return res.status(500).send('Database error');
            }

            // Log error to the console in red
            console.log('\x1b[31m%s\x1b[0m', `Error reported: ${error}\nLocation: ${location}`);

            return res.status(200).send('Error reported');
        });
    } else {
        return res.status(400).send('Invalid data');
    }
});



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


//? endpoint to check server availability.
router.get('/alive', function (req, res, next) {
    return res.send('Server connection is Okay!');
});

module.exports = router;