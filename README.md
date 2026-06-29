# VICIdial Leaderboard v2

## Folder structure
```
leaderboard/
├── server.js
├── package.json
├── public/
│   ├── index.html      ← leaderboard (public)
│   ├── app.js
│   ├── styles.css
│   └── admin/
│       └── index.html  ← admin panel (password protected)
└── data/
    ├── sample-leaderboard.json
    ├── config.json          ← created automatically on first save
    └── fetch.log            ← created automatically
```

## Start
```powershell
npm start
```

## Custom admin password (optional)
```powershell
$env:ADMIN_PASSWORD="yourpassword"
npm start
```
Default password is: admin1234

## URLs
- Leaderboard: http://localhost:4173/
- Admin panel:  http://localhost:4173/admin/

## On your VPS
To run forever, install PM2:
```bash
npm install -g pm2
pm2 start server.js --name leaderboard
pm2 save
pm2 startup
```
Then open port 4173 in your firewall.
