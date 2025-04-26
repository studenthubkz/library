const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const bodyParser = require('body-parser');
const os = require('os');
let ngrok;

// Пробуем загрузить ngrok и настраиваем токен
try {
    ngrok = require('ngrok');
    // Настройка автотокена для ngrok
    const NGROK_AUTH_TOKEN = '2nC0WF6hn74rE8ZN9jolMFzBfMe_5gRf29BPop9EUQgnmYTBX'; // Замените на ваш токен ngrok
    if (NGROK_AUTH_TOKEN && NGROK_AUTH_TOKEN !== 'ваш_токен_ngrok_здесь') {
        ngrok.authtoken(NGROK_AUTH_TOKEN)
            .then(() => console.log('Ngrok токен успешно установлен'))
            .catch(err => console.error('Ошибка при установке токена ngrok:', err));
    } else {
        console.log('Автотокен ngrok не настроен. Для настройки замените значение NGROK_AUTH_TOKEN');
    }
} catch (error) {
    console.log('Не удалось загрузить модуль ngrok, внешний URL не будет создан');
}

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server); // Правильная инициализация Socket.IO

// Создаем директорию для базы данных, если она не существует
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
}

// Инициализация SQLite базы данных
const db = new sqlite3.Database(path.join(__dirname, 'library.db'));

// Создаем необходимые таблицы
db.serialize(() => {
    // Таблица для пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Таблица для книг
    db.run(`CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        genre TEXT NOT NULL,
        description TEXT,
        link TEXT NOT NULL,
        image TEXT NOT NULL,
        is_paid BOOLEAN DEFAULT 0,
        price INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Таблица для купленных книг
    db.run(`CREATE TABLE IF NOT EXISTS purchased_books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (book_id) REFERENCES books (id),
        UNIQUE(user_id, book_id)
    )`);
    
    // Таблица для платежных сессий
    db.run(`CREATE TABLE IF NOT EXISTS payment_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (book_id) REFERENCES books (id)
    )`);
    
    // Проверяем, есть ли книги в базе данных
    db.get("SELECT COUNT(*) as count FROM books", (err, row) => {
        if (err) {
            console.error('Ошибка при проверке наличия книг:', err);
            return;
        }
        
        // Если книг нет, добавляем начальные данные
        if (row.count === 0) {
            // Загружаем данные из database.json
            try {
                const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'database.json'), 'utf8'));
                
                // Добавляем пользователей
                const insertUserStmt = db.prepare("INSERT INTO users (email, password, name) VALUES (?, ?, ?)");
                data.users.forEach(user => {
                    insertUserStmt.run(user.email, user.password, user.name);
                });
                insertUserStmt.finalize();
                
                // Добавляем книги
                const insertBookStmt = db.prepare("INSERT INTO books (title, author, genre, description, link, image, is_paid, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
                data.books.forEach(book => {
                    insertBookStmt.run(
                        book.title, 
                        book.author, 
                        book.genre, 
                        book.description, 
                        book.link, 
                        book.image, 
                        book.isPaid ? 1 : 0, 
                        book.price
                    );
                });
                insertBookStmt.finalize();
                
                console.log('Начальные данные успешно добавлены в базу данных');
            } catch (error) {
                console.error('Ошибка при импорте начальных данных:', error);
            }
        }
    });
});

// Настройка Express
app.use(express.static(__dirname));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// WebSocket комнаты для сессий оплаты
const paymentSessions = new Map(); // Маппинг sessionId -> socket.id

// Обработка WebSocket соединений
io.on('connection', (socket) => {
    console.log('Новое подключение к WebSocket:', socket.id);
    
    // Обработка присоединения к комнате сессии оплаты
    socket.on('join-payment-session', (sessionId) => {
        console.log(`Сокет ${socket.id} присоединился к сессии оплаты ${sessionId}`);
        
        // Добавляем сокет в комнату с ID сессии
        socket.join(sessionId);
        
        // Сохраняем маппинг сессии и сокета
        paymentSessions.set(sessionId, socket.id);
    });
    
    // Обработка обновления статуса оплаты
    socket.on('payment-status-update', (data) => {
        console.log('Получено обновление статуса платежа:', data);
        
        if (!data.sessionId) {
            console.error('sessionId отсутствует в данных обновления статуса');
            return;
        }
        
        // Обновляем статус в базе данных
        db.run(
            `UPDATE payment_sessions 
             SET status = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ?`,
            [data.status, data.sessionId],
            function(err) {
                if (err) {
                    console.error('Ошибка при обновлении статуса сессии в БД:', err);
                    return;
                }
                
                console.log(`Статус сессии ${data.sessionId} обновлен на ${data.status}`);
                
                // Если статус "completed", добавляем запись в таблицу купленных книг
                if (data.status === 'completed' && data.userId && data.bookId) {
                    db.run(
                        `INSERT OR IGNORE INTO purchased_books (user_id, book_id) VALUES (?, ?)`,
                        [data.userId, data.bookId],
                        function(err) {
                            if (err) {
                                console.error('Ошибка при добавлении записи о покупке:', err);
                            } else {
                                console.log(`Книга ${data.bookId} добавлена в список купленных пользователем ${data.userId}`);
                            }
                        }
                    );
                }
                
                // Отправляем обновление всем клиентам в комнате сессии
                io.to(data.sessionId).emit('payment-status-changed', data);
            }
        );
    });
    
    // Обработка отключения клиента
    socket.on('disconnect', () => {
        console.log('Клиент отключился:', socket.id);
        
        // Удаляем сессии, связанные с этим сокетом
        for (const [sessionId, socketId] of paymentSessions.entries()) {
            if (socketId === socket.id) {
                paymentSessions.delete(sessionId);
                console.log(`Удалена сессия ${sessionId} из-за отключения клиента`);
            }
        }
    });
});

// API endpoints

// Endpoint для получения списка книг
app.get('/api/books', (req, res) => {
    db.all("SELECT * FROM books", (err, rows) => {
        if (err) {
            console.error('Ошибка при получении списка книг:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
        
        // Преобразуем is_paid из числа в boolean
        const books = rows.map(book => ({
            id: book.id,
            title: book.title,
            author: book.author,
            genre: book.genre,
            description: book.description,
            link: book.link,
            image: book.image,
            isPaid: book.is_paid === 1,
            price: book.price
        }));
        
        res.json({ success: true, books });
    });
});

// Endpoint для регистрации пользователя
app.post('/api/register', (req, res) => {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
    }
    
    // Проверяем, существует ли пользователь с таким email
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
        if (err) {
            console.error('Ошибка при проверке существования пользователя:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
        
        if (row) {
            return res.status(400).json({ success: false, message: 'Пользователь с таким email уже существует' });
        }
        
        // Добавляем нового пользователя
        db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, password], function(err) {
            if (err) {
                console.error('Ошибка при добавлении пользователя:', err);
                return res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
            
            res.json({ success: true, message: 'Пользователь успешно зарегистрирован', userId: this.lastID });
        });
    });
});

// Endpoint для входа пользователя
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
    }
    
    // Ищем пользователя с указанными email и паролем
    db.get("SELECT * FROM users WHERE email = ? AND password = ?", [email, password], (err, row) => {
        if (err) {
            console.error('Ошибка при поиске пользователя:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
        
        if (!row) {
            return res.status(401).json({ success: false, message: 'Неверный email или пароль' });
        }
        
        // Отправляем информацию о пользователе
        res.json({ 
            success: true, 
            message: 'Вход выполнен успешно', 
            user: {
                id: row.id,
                name: row.name,
                email: row.email
            }
        });
    });
});

// Endpoint для получения списка купленных книг пользователя
app.get('/api/user-books/:userId', (req, res) => {
    const userId = req.params.userId;
    
    if (!userId) {
        return res.status(400).json({ success: false, message: 'ID пользователя не указан' });
    }
    
    // Получаем список купленных книг
    db.all(
        `SELECT b.* FROM books b
         JOIN purchased_books pb ON b.id = pb.book_id
         WHERE pb.user_id = ?`,
        [userId],
        (err, rows) => {
            if (err) {
                console.error('Ошибка при получении списка купленных книг:', err);
                return res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
            
            // Преобразуем is_paid из числа в boolean
            const books = rows.map(book => ({
                id: book.id,
                title: book.title,
                author: book.author,
                genre: book.genre,
                description: book.description,
                link: book.link,
                image: book.image,
                isPaid: book.is_paid === 1,
                price: book.price
            }));
            
            res.json({ success: true, books });
        }
    );
});

// Endpoint для создания платежной сессии
app.post('/api/payment-session', (req, res) => {
    const { userId, bookId } = req.body;
    
    if (!userId || !bookId) {
        return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
    }
    
    // Проверяем, не купил ли пользователь уже эту книгу
    db.get(
        "SELECT * FROM purchased_books WHERE user_id = ? AND book_id = ?",
        [userId, bookId],
        (err, row) => {
            if (err) {
                console.error('Ошибка при проверке покупки книги:', err);
                return res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
            
            // Если книга уже куплена, сообщаем об этом
            if (row) {
                return res.json({ success: true, alreadyPurchased: true, message: 'Книга уже куплена' });
            }
            
            // Генерируем уникальный идентификатор сессии
            const sessionId = `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            // Создаем новую платежную сессию
            db.run(
                "INSERT INTO payment_sessions (session_id, user_id, book_id) VALUES (?, ?, ?)",
                [sessionId, userId, bookId],
                function(err) {
                    if (err) {
                        console.error('Ошибка при создании платежной сессии:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка сервера' });
                    }
                    
                    res.json({ 
                        success: true, 
                        sessionId, 
                        userId,
                        bookId,
                        message: 'Платежная сессия успешно создана' 
                    });
                }
            );
        }
    );
});

// Endpoint для обновления статуса платежа
app.post('/api/payment-status', (req, res) => {
    const { sessionId, status } = req.body;
    
    if (!sessionId || !status) {
        return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
    }
    
    // Получаем информацию о сессии
    db.get(
        "SELECT * FROM payment_sessions WHERE session_id = ?",
        [sessionId],
        (err, session) => {
            if (err) {
                console.error('Ошибка при получении информации о сессии:', err);
                return res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
            
            if (!session) {
                return res.status(404).json({ success: false, message: 'Сессия не найдена' });
            }
            
            // Обновляем статус сессии
            db.run(
                `UPDATE payment_sessions 
                 SET status = ?, updated_at = CURRENT_TIMESTAMP 
                 WHERE session_id = ?`,
                [status, sessionId],
                function(err) {
                    if (err) {
                        console.error('Ошибка при обновлении статуса сессии:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка сервера' });
                    }
                    
                    console.log(`Статус сессии ${sessionId} обновлен на ${status}`);
                    
                    // Если статус "completed", добавляем запись в таблицу купленных книг
                    if (status === 'completed') {
                        db.run(
                            `INSERT OR IGNORE INTO purchased_books (user_id, book_id) VALUES (?, ?)`,
                            [session.user_id, session.book_id],
                            function(err) {
                                if (err) {
                                    console.error('Ошибка при добавлении записи о покупке:', err);
                                    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
                                }
                                
                                console.log(`Книга ${session.book_id} добавлена в список купленных пользователем ${session.user_id}`);
                                
                                // Отправляем обновление всем клиентам в комнате сессии
                                io.to(sessionId).emit('payment-status-changed', {
                                    sessionId,
                                    status,
                                    bookId: session.book_id,
                                    userId: session.user_id
                                });
                                
                                res.json({ success: true, message: 'Статус платежа успешно обновлен' });
                            }
                        );
                    } else {
                        // Отправляем обновление всем клиентам в комнате сессии
                        io.to(sessionId).emit('payment-status-changed', {
                            sessionId,
                            status,
                            bookId: session.book_id,
                            userId: session.user_id
                        });
                        
                        res.json({ success: true, message: 'Статус платежа успешно обновлен' });
                    }
                }
            );
        }
    );
});

// Endpoint для получения статуса платежной сессии
app.get('/api/payment-session/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    
    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'ID сессии не указан' });
    }
    
    // Получаем информацию о сессии
    db.get(
        "SELECT * FROM payment_sessions WHERE session_id = ?",
        [sessionId],
        (err, session) => {
            if (err) {
                console.error('Ошибка при получении информации о сессии:', err);
                return res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
            
            if (!session) {
                return res.status(404).json({ success: false, message: 'Сессия не найдена' });
            }
            
            res.json({ 
                success: true, 
                session: {
                    id: session.id,
                    sessionId: session.session_id,
                    userId: session.user_id,
                    bookId: session.book_id,
                    status: session.status,
                    createdAt: session.created_at,
                    updatedAt: session.updated_at
                }
            });
        }
    );
});

// Обработка запросов к статическим файлам
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/payment.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'payment.html'));
});

// Обработка 404 ошибок
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// Обработка запроса favicon.ico
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // Возвращаем пустой ответ
});

// Функция для получения локального IP-адреса
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const config of iface) {
            if (config.family === 'IPv4' && !config.internal) {
                return config.address;
            }
        }
    }
    return 'localhost';
}

const PORT = 3000; // Убедитесь, что ваш сервер слушает этот порт

// Запуск сервера
server.listen(PORT, async () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    
    // Пытаемся получить локальный IP для доступа из локальной сети
    const localIp = getLocalIp();
    if (localIp !== 'localhost') {
        console.log(`Доступен в локальной сети: http://${localIp}:${PORT}`);
    }
    
    // Создаем туннель ngrok, если модуль доступен
    if (ngrok) {
        try {
            const url = await ngrok.connect({
                addr: PORT,
                proto: 'http'
            });
            console.log(`Публичный URL ngrok: ${url}`);
        } catch (err) {
            console.error('Ошибка при создании туннеля ngrok:', err);
        }
    }
});
