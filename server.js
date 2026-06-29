const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "sample-leaderboard.json");
const CONFIG_FILE = path.join(__dirname, "data", "config.json");
const LOG_FILE = path.join(__dirname, "data", "fetch.log");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troy0611";
const sessions = new Set();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const DEFAULT_CONFIG = {
  refreshInterval: 60,
  campaigns: [
    { id:"default", name:"Meals", reportUrl:"", basicAuth:"", cookie:"", teams:[], agentAliases:{} }
  ]
};

function readConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE,"utf8")) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE),{recursive:true});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg,null,2));
}

const logs = [];
function addLog(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry)+"\n"); } catch {}
}

function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function checkSession(req) {
  const m = (req.headers.cookie||"").match(/admin_token=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
}

function send(res, status, body, ct) {
  ct = ct || "text/plain; charset=utf-8";
  res.writeHead(status, {"Content-Type": ct, "Cache-Control": "no-store"});
  if (Buffer.isBuffer(body)) { res.end(body); return; }
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}
function readBody(req) {
  return new Promise(function(resolve, reject) {
    var c = [];
    req.on("data", function(d) { c.push(d); });
    req.on("end", function() { resolve(Buffer.concat(c).toString()); });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  var rp = decodeURIComponent(req.url.split("?")[0]);
  if (rp === "/" || rp === "") {
    rp = "/index.html";
  } else if (rp.endsWith("/")) {
    rp = rp + "index.html";
  } else if (!path.extname(rp)) {
    rp = rp + "/index.html";
  }
  var fp = path.normalize(path.join(PUBLIC_DIR, rp));
  if (!fp.startsWith(PUBLIC_DIR)) { send(res, 403, "Forbidden"); return; }
  fs.readFile(fp, function(err, data) {
    if (err) { send(res, 404, "Not found"); return; }
    var ext = path.extname(fp).toLowerCase();
    send(res, 200, data, MIME_TYPES[ext] || "application/octet-stream");
  });
}

function parseDuration(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  var p = String(v).trim().split(":").map(Number);
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*60 + p[1];
  return Number(v) || 0;
}
function cleanNumber(v) {
  return Number(String(v||"0").replace(/,/g,"").trim()) || 0;
}
function normalizeAgent(row, index, campaign) {
  campaign = campaign || {};
  var rawName = row.name || row.agent || row["Agent Name"] || "Agent "+(index+1);
  var name = (campaign.agentAliases||{})[rawName] || rawName;
  var team = row.team || row.campaign || row["Agent ID"] || "Main floor";
  var sales = cleanNumber(row.sales||row.Sales||row.closes||0);
  var nonPauseSeconds = parseDuration(row.nonPauseSeconds||row.nonpauseSeconds||row.nonPauseTime||row.nonpauseTime||row["Nonpause Time"]);
  var hours = nonPauseSeconds / 3600;
  var salesPerWorkingHour = cleanNumber(row.salesPerWorkingHour||row["Sales per Working Hour"]||(hours ? sales/hours : 0));
  return { rank: index+1, name: name, team: team, sales: sales, salesPerWorkingHour: salesPerWorkingHour, nonPauseSeconds: nonPauseSeconds };
}

function stripHtml(t) {
  return String(t)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseVicidialText(text, campaign) {
  var plain = stripHtml(text);
  var lines = plain.split(/\r?\n/);
  var headerLine = null;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].includes("Agent Name") && lines[i].includes("Sales per Working Hour")) {
      headerLine = lines[i];
      break;
    }
  }
  if (!headerLine) {
    if (/Login incorrect|BAD|Unauthorized|401/i.test(plain)) throw new Error("VICIdial login rejected.");
    throw new Error("Could not find VICIdial table headers.");
  }
  var headers = headerLine.split("|").map(function(h){ return h.trim(); }).filter(Boolean);
  var headerIndex = lines.indexOf(headerLine);
  var agents = [];
  for (var j = headerIndex+1; j < lines.length; j++) {
    var line = lines[j];
    if (!line.includes("|")) continue;
    if (/TOTALS\s*:/i.test(line)) break;
    if (/^-+$/.test(line.replace(/[+|]/g,"").trim())) continue;
    var cells = line.split("|").map(function(c){ return c.trim(); });
    if (cells.length < headers.length) continue;
    var values = cells[0] === "" ? cells.slice(1) : cells;
    var row = {};
    headers.forEach(function(h, idx){ row[h] = values[idx] || ""; });
    if (row["Agent Name"] && row["Agent Name"] !== "Agent Name") {
      agents.push(normalizeAgent(row, agents.length, campaign));
    }
  }
  if (!agents.length) throw new Error("VICIdial report loaded but no agent rows found.");
  return agents;
}

function parseJson(body, campaign) {
  var parsed = JSON.parse(body);
  var rows = Array.isArray(parsed) ? parsed : (parsed.agents || parsed.leaderboard || []);
  return rows.map(function(r, i){ return normalizeAgent(r, i, campaign); });
}

function patchUrlDate(rawUrl, dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    var now = new Date();
    var pad = function(n){ return String(n).padStart(2,"0"); };
    dateStr = now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate());
  }
  var enc = encodeURIComponent(dateStr);
  return rawUrl
    .replace(/query_date=\d{4}-\d{2}-\d{2}/g, "query_date="+enc)
    .replace(/query_date_D=\d{4}-\d{2}-\d{2}/g, "query_date_D="+enc)
    .replace(/end_date=\d{4}-\d{2}-\d{2}/g, "end_date="+enc)
    .replace(/end_date_D=\d{4}-\d{2}-\d{2}/g, "end_date_D="+enc);
}

function dateRange(fromStr, toStr) {
  var dates = [];
  var cur = new Date(fromStr+"T00:00:00");
  var end = new Date(toStr+"T00:00:00");
  while (cur <= end) {
    var pad = function(n){ return String(n).padStart(2,"0"); };
    dates.push(cur.getFullYear()+"-"+pad(cur.getMonth()+1)+"-"+pad(cur.getDate()));
    cur.setDate(cur.getDate()+1);
  }
  return dates;
}

async function fetchOneDay(campaign, dateStr) {
  var reportUrl = patchUrlDate(campaign.reportUrl, dateStr);
  addLog("info", "["+campaign.name+"] Fetching "+dateStr);
  var headers = {};
  if (campaign.basicAuth) headers.Authorization = "Basic "+Buffer.from(campaign.basicAuth).toString("base64");
  if (campaign.cookie) headers.Cookie = campaign.cookie;
  var response = await fetch(reportUrl, {headers: headers});
  var body = await response.text();
  if (!response.ok) {
    if (/Login incorrect|BAD/i.test(body)) throw new Error("VICIdial login rejected.");
    throw new Error("VICIdial returned HTTP "+response.status);
  }
  var ct = response.headers.get("content-type") || "";
  var trimmed = body.trim();
  if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJson(trimmed, campaign);
  }
  return parseVicidialText(trimmed, campaign);
}

function mergeAgentDays(allDayResults) {
  var map = new Map();
  for (var i = 0; i < allDayResults.length; i++) {
    var dayAgents = allDayResults[i];
    for (var j = 0; j < dayAgents.length; j++) {
      var agent = dayAgents[j];
      var key = agent.name+"|"+agent.team;
      if (!map.has(key)) {
        map.set(key, Object.assign({}, agent));
      } else {
        var ex = map.get(key);
        ex.sales += agent.sales;
        ex.nonPauseSeconds += agent.nonPauseSeconds;
      }
    }
  }
  return Array.from(map.values()).map(function(a) {
    var hours = a.nonPauseSeconds / 3600;
    a.salesPerWorkingHour = hours > 0 ? Math.round((a.sales/hours)*100)/100 : 0;
    return a;
  });
}

function sortAgents(agents) {
  return agents
    .sort(function(a,b){ return b.sales - a.sales || b.salesPerWorkingHour - a.salesPerWorkingHour; })
    .map(function(a, i){ return Object.assign({}, a, {rank: i+1}); });
}

function readSample(campaign) {
  return parseJson(fs.readFileSync(DATA_FILE,"utf8"), campaign);
}

async function getLeaderboard(campaignId, fromStr, toStr) {
  var config = readConfig();
  var campaigns = config.campaigns || [];
  var campaign = campaigns.find(function(c){ return c.id === campaignId; }) || campaigns[0];
  if (!campaign) return {source:"sample", agents:sortAgents(readSample({})), campaignName:"Default"};
  try {
    if (!campaign.reportUrl) {
      addLog("warn", "["+campaign.name+"] No URL, using sample data.");
      return {source:"sample", agents:sortAgents(readSample(campaign)), campaignName:campaign.name};
    }
    var dates = dateRange(fromStr || toStr, toStr || fromStr);
    var allDayResults = [];
    for (var i = 0; i < dates.length; i++) {
      try {
        var dayAgents = await fetchOneDay(campaign, dates[i]);
        var filtered = (campaign.teams && campaign.teams.length)
          ? dayAgents.filter(function(a){ return campaign.teams.includes(a.team); })
          : dayAgents;
        allDayResults.push(filtered);
      } catch(e) {
        addLog("warn", "["+campaign.name+"] Skipped "+dates[i]+": "+e.message);
      }
    }
    if (!allDayResults.length) throw new Error("No data found for any day in this range.");
    var merged = mergeAgentDays(allDayResults);
    addLog("info", "["+campaign.name+"] Merged "+allDayResults.length+" days, "+merged.length+" agents.");
    return {source:"vicidial", agents:sortAgents(merged), campaignName:campaign.name};
  } catch(err) {
    addLog("error", "["+campaign.name+"] "+err.message);
    return {source:"sample", agents:sortAgents(readSample(campaign)), campaignName:campaign.name, error:err.message};
  }
}

async function router(req, res) {
  var url = new URL(req.url, "http://x");
  var p = url.pathname;
  var m = req.method;

  if (p === "/api/leaderboard" && m === "GET") {
    var campaignId = url.searchParams.get("campaign") || "";
    var fromStr = url.searchParams.get("dateFrom") || "";
    var toStr = url.searchParams.get("dateTo") || fromStr;
    var result = await getLeaderboard(campaignId, fromStr, toStr);
    var config = readConfig();
    sendJson(res, 200, {
      source: result.source,
      refreshedAt: new Date().toISOString(),
      refreshInterval: config.refreshInterval || 60,
      campaignName: result.campaignName,
      agents: result.agents,
      error: result.error || null
    });
    return;
  }

  if (p === "/api/campaigns" && m === "GET") {
    var config = readConfig();
    sendJson(res, 200, (config.campaigns||[]).map(function(c){ return {id:c.id, name:c.name}; }));
    return;
  }

  if (p === "/api/admin/login" && m === "POST") {
    var body = await readBody(req);
    var pw = "";
    try { pw = JSON.parse(body).password; } catch(e) {}
    if (pw === ADMIN_PASSWORD) {
      var token = makeToken();
      sessions.add(token);
      res.writeHead(200, {"Set-Cookie":"admin_token="+token+"; HttpOnly; Path=/; Max-Age=86400", "Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
    } else {
      sendJson(res, 401, {ok:false, error:"Wrong password"});
    }
    return;
  }

  if (p === "/api/admin/logout" && m === "POST") {
    var match = (req.headers.cookie||"").match(/admin_token=([a-f0-9]+)/);
    if (match) sessions.delete(match[1]);
    res.writeHead(200, {"Set-Cookie":"admin_token=; Max-Age=0; Path=/", "Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  if (p.startsWith("/api/admin/") && !checkSession(req)) {
    sendJson(res, 401, {error:"Not authenticated"}); return;
  }

  if (p === "/api/admin/config" && m === "GET") { sendJson(res, 200, readConfig()); return; }

  if (p === "/api/admin/config" && m === "POST") {
    var body = await readBody(req);
    var inc;
    try { inc = JSON.parse(body); } catch(e) { sendJson(res, 400, {error:"Bad JSON"}); return; }
    writeConfig(Object.assign({}, readConfig(), inc));
    addLog("info", "Config saved.");
    sendJson(res, 200, {ok:true});
    return;
  }

  if (p === "/api/admin/logs" && m === "GET") { sendJson(res, 200, logs); return; }

  if (p === "/api/admin/test" && m === "POST") {
    var body = await readBody(req);
    var campaign;
    try { campaign = JSON.parse(body); } catch(e) { sendJson(res, 400, {error:"Bad JSON"}); return; }
    try {
      var agents = await fetchOneDay(campaign, "");
      sendJson(res, 200, {ok:true, agentCount:agents.length, sample:agents.slice(0,3)});
    } catch(err) {
      sendJson(res, 200, {ok:false, error:err.message});
    }
    return;
  }

  serveStatic(req, res);
}

http.createServer(function(req, res) {
  router(req, res).catch(function(err) {
    addLog("error", "Unhandled: "+err.message);
    sendJson(res, 500, {error:"Internal server error"});
  });
}).listen(PORT, function() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Leaderboard → http://localhost:"+PORT);
  console.log("  Admin panel  → http://localhost:"+PORT+"/admin/");
  console.log("  Admin password: "+ADMIN_PASSWORD);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  addLog("info", "Server started on port "+PORT);
});
