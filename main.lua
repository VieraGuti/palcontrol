-- PalControlBridge v1.0.5
-- UE4SS server-side bridge for Palworld / PalControl.
-- Provides: heartbeat, live players/positions, chat + join/leave events,
-- best-effort loaded-character snapshot, and a file-based command channel.

local MOD_NAME = "PalControlBridge"
local VERSION = "1.0.5"

local PLAYER_REFRESH_MS = 2000
local PLAYER_RESCAN_MS = 30000
local WORLD_REFRESH_MS = 5000
local WORLD_RESCAN_MS = 60000
local HEARTBEAT_MS = 5000
local COMMAND_POLL_MS = 1000
local EVENT_ROTATE_BYTES = 5 * 1024 * 1024

local function log(msg)
    print(string.format("[%s] %s\n", MOD_NAME, tostring(msg)))
end

local function scriptPath()
    local src = debug.getinfo(1, "S").source or ""
    return src:match("^@(.+)$") or src
end

local function dirname(p)
    return p:match("^(.*)[/\\][^/\\]+$")
end

local SCRIPT_DIR = dirname(scriptPath())
local MOD_DIR = SCRIPT_DIR and dirname(SCRIPT_DIR) or nil
if not MOD_DIR then
    log("FATAL: could not derive mod directory")
    return
end

local DATA_DIR = MOD_DIR .. "/data"
local HEARTBEAT_PATH = DATA_DIR .. "/heartbeat.json"
local ACTORS_PATH = DATA_DIR .. "/actors.json"
local WORLD_PATH = DATA_DIR .. "/world.json"
local EVENTS_PATH = DATA_DIR .. "/events.jsonl"
local EVENTS_OLD_PATH = DATA_DIR .. "/events.old.jsonl"
local COMMAND_PATH = DATA_DIR .. "/command.json"
local RESPONSE_PATH = DATA_DIR .. "/response.json"
local STATE_PATH = DATA_DIR .. "/state.json"

os.execute('mkdir "' .. DATA_DIR .. '" 2>nul')

local function esc(v)
    local s = tostring(v or "")
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    s = s:gsub("\b", "\\b")
    s = s:gsub("\f", "\\f")
    s = s:gsub("\n", "\\n")
    s = s:gsub("\r", "\\r")
    s = s:gsub("\t", "\\t")
    return s
end

local function jsonString(v) return '"' .. esc(v) .. '"' end

local function jsonValue(v)
    local t = type(v)
    if v == nil then return "null" end
    if t == "boolean" then return v and "true" or "false" end
    if t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then return "null" end
        return tostring(v)
    end
    if t == "string" then return jsonString(v) end
    if t == "table" then
        local isArray = true
        local max = 0
        local count = 0
        for k, _ in pairs(v) do
            count = count + 1
            if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then isArray = false break end
            if k > max then max = k end
        end
        if isArray and max == count then
            local out = {}
            for i = 1, max do out[#out + 1] = jsonValue(v[i]) end
            return "[" .. table.concat(out, ",") .. "]"
        end
        local out = {}
        for k, value in pairs(v) do
            out[#out + 1] = jsonString(k) .. ":" .. jsonValue(value)
        end
        return "{" .. table.concat(out, ",") .. "}"
    end
    return jsonString(tostring(v))
end

-- Small JSON parser sufficient for PalControl's flat command objects.
local function decodeJson(text)
    local i, n = 1, #text
    local function skip()
        while i <= n and text:sub(i, i):match("%s") do i = i + 1 end
    end
    local parseValue
    local function parseString()
        if text:sub(i, i) ~= '"' then error("expected string") end
        i = i + 1
        local out = {}
        while i <= n do
            local c = text:sub(i, i)
            if c == '"' then i = i + 1 return table.concat(out) end
            if c == "\\" then
                i = i + 1
                local e = text:sub(i, i)
                local map = { ['"']='"', ['\\']='\\', ['/']='/', ['b']='\b', ['f']='\f', ['n']='\n', ['r']='\r', ['t']='\t' }
                if e == 'u' then
                    local hex = text:sub(i + 1, i + 4)
                    local cp = tonumber(hex, 16)
                    if cp and cp < 128 then out[#out + 1] = string.char(cp) else out[#out + 1] = "?" end
                    i = i + 4
                else
                    out[#out + 1] = map[e] or e
                end
            else
                out[#out + 1] = c
            end
            i = i + 1
        end
        error("unterminated string")
    end
    local function parseNumber()
        local s = i
        while i <= n and text:sub(i, i):match("[%d%+%-%.eE]") do i = i + 1 end
        local v = tonumber(text:sub(s, i - 1))
        if v == nil then error("bad number") end
        return v
    end
    local function parseObject()
        local obj = {}
        i = i + 1
        skip()
        if text:sub(i, i) == "}" then i = i + 1 return obj end
        while i <= n do
            skip()
            local k = parseString()
            skip()
            if text:sub(i, i) ~= ":" then error("expected colon") end
            i = i + 1
            skip()
            obj[k] = parseValue()
            skip()
            local c = text:sub(i, i)
            if c == "}" then i = i + 1 return obj end
            if c ~= "," then error("expected comma") end
            i = i + 1
        end
        error("unterminated object")
    end
    local function parseArray()
        local arr = {}
        i = i + 1
        skip()
        if text:sub(i, i) == "]" then i = i + 1 return arr end
        while i <= n do
            skip()
            arr[#arr + 1] = parseValue()
            skip()
            local c = text:sub(i, i)
            if c == "]" then i = i + 1 return arr end
            if c ~= "," then error("expected comma") end
            i = i + 1
        end
        error("unterminated array")
    end
    parseValue = function()
        skip()
        local c = text:sub(i, i)
        if c == '"' then return parseString() end
        if c == "{" then return parseObject() end
        if c == "[" then return parseArray() end
        if text:sub(i, i + 3) == "true" then i = i + 4 return true end
        if text:sub(i, i + 4) == "false" then i = i + 5 return false end
        if text:sub(i, i + 3) == "null" then i = i + 4 return nil end
        return parseNumber()
    end
    local value = parseValue()
    skip()
    return value
end

local function atomicWrite(path, content)
    local tmp = path .. ".tmp"
    local f, err = io.open(tmp, "w")
    if not f then return false, tostring(err) end
    f:write(content)
    f:close()
    os.remove(path)
    local ok, renameErr = os.rename(tmp, path)
    if not ok then return false, tostring(renameErr) end
    return true
end

local function readFile(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    if not content or content == "" then return nil end
    return content
end

local function appendFile(path, content)
    local f, err = io.open(path, "a")
    if not f then return false, tostring(err) end
    f:write(content)
    f:close()
    return true
end

local function rotateEventsIfNeeded()
    local f = io.open(EVENTS_PATH, "r")
    if not f then return end
    local size = f:seek("end") or 0
    f:close()
    if size >= EVENT_ROTATE_BYTES then
        os.remove(EVENTS_OLD_PATH)
        os.rename(EVENTS_PATH, EVENTS_OLD_PATH)
    end
end

local seq = 0
local function emitEvent(kind, fields)
    seq = seq + 1
    local event = fields or {}
    event.type = kind
    event.seq = seq
    event.timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    rotateEventsIfNeeded()
    local ok, err = appendFile(EVENTS_PATH, jsonValue(event) .. "\n")
    if not ok then log("event write failed: " .. tostring(err)) end
end

local function valid(obj)
    if not obj then return false end
    local ok, result = pcall(function() return obj:IsValid() end)
    return ok and result == true
end

local function guidParts(uid)
    if not uid then return nil end
    local ok, parts = pcall(function()
        return {
            A = tonumber(uid.A) or 0,
            B = tonumber(uid.B) or 0,
            C = tonumber(uid.C) or 0,
            D = tonumber(uid.D) or 0
        }
    end)
    return ok and parts or nil
end

local function guidToString(uid)
    local p = guidParts(uid)
    if not p then return "" end
    return string.format("%08X-%08X-%08X-%08X", p.A, p.B, p.C, p.D)
end

local function getPlayerName(ps)
    local name = ""
    pcall(function()
        if ps.PlayerNamePrivate then name = ps.PlayerNamePrivate:ToString() end
    end)
    if name == "" then
        pcall(function()
            if ps.SavedPlayerName then name = ps.SavedPlayerName:ToString() end
        end)
    end
    return name
end

local function getUid(ps)
    local ok, uid = pcall(function() return ps.PlayerUId end)
    if not ok or not uid then return "" end
    return guidToString(uid)
end

local function getController(ps)
    local ok, pc = pcall(function() return ps:GetPlayerController() end)
    if ok and valid(pc) then return pc end
    return nil
end

local function getPawn(ps)
    local pc = getController(ps)
    if pc then
        local ok, pawn = pcall(function() return pc.Pawn end)
        if ok and valid(pawn) then return pawn end
    end
    local candidates = { "PawnPrivate", "Pawn", "CachedCharacter", "CharacterPawn" }
    for _, prop in ipairs(candidates) do
        local ok, pawn = pcall(function() return ps[prop] end)
        if ok and valid(pawn) then return pawn end
    end
    return nil
end

local function getLocation(actor)
    if not valid(actor) then return nil end
    local ok, loc = pcall(function() return actor:K2_GetActorLocation() end)
    if ok and loc then
        return { x = tonumber(loc.X) or 0, y = tonumber(loc.Y) or 0, z = tonumber(loc.Z) or 0 }
    end
    return nil
end

local function getFullName(obj)
    local ok, value = pcall(function() return obj:GetFullName() end)
    return ok and tostring(value) or ""
end

local function getClassName(obj)
    local ok, value = pcall(function()
        local cls = obj:GetClass()
        if not cls then return "" end
        local fn = cls:GetFName()
        if fn and fn.ToString then return fn:ToString() end
        return tostring(fn)
    end)
    return ok and tostring(value) or ""
end

local function getControllerFullName(actor)
    local ok, ctrl = pcall(function() return actor.Controller end)
    if not ok or not valid(ctrl) then return "" end
    return getFullName(ctrl)
end

local function getCharacterLevel(actor)
    local level = nil
    pcall(function()
        local cpc = actor.CharacterParameterComponent or actor:GetCharacterParameterComponent()
        if cpc and cpc:IsValid() then level = tonumber(cpc:GetLevel()) end
    end)
    return level
end

local function getBaseLocation(base)
    local transform = nil
    pcall(function() transform = base:GetTransform() end)
    if not transform then pcall(function() transform = base.Transform end) end
    if not transform then return nil end
    local v = nil
    pcall(function() v = transform.Translation end)
    if not v then pcall(function() v = transform.Location end) end
    if not v then return nil end
    local x, y, z = tonumber(v.X), tonumber(v.Y), tonumber(v.Z)
    if not x or not y then return nil end
    return { x = x, y = y, z = z or 0 }
end

local function getBaseName(base)
    local out = ""
    pcall(function()
        local v = base:GetBaseCampName()
        if v then out = v.ToString and v:ToString() or tostring(v) end
    end)
    if out == "" then
        pcall(function()
            local v = base.BaseCampName
            if v then out = v.ToString and v:ToString() or tostring(v) end
        end)
    end
    return out
end

local function getBaseGuid(base, methodName, propertyName)
    local out = ""
    pcall(function()
        local v = base[methodName](base)
        out = guidToString(v)
    end)
    if out == "" then
        pcall(function() out = guidToString(base[propertyName]) end)
    end
    return out
end

local playerCache = {}
local playerStatesCache = {}
local activePlayerStatesByName = {}
local inventoryCacheByUid = {}

local function playerStateKey(ps)
    local ok, addr = pcall(function() return ps:GetAddress() end)
    if ok and addr then return tostring(addr) end
    local uid = getUid(ps)
    if uid ~= "" then return uid end
    return getPlayerName(ps)
end

local function cachePlayerState(ps)
    if not valid(ps) then return end
    local key = playerStateKey(ps)
    if key and key ~= "" then playerStatesCache[key] = ps end
    local name = getPlayerName(ps)
    if name and name ~= "" then
        activePlayerStatesByName[name:lower()] = ps
    end
end

local function rescanPlayerStates()
    local states = nil
    pcall(function() states = FindAllOf("PalPlayerState") end)
    if states then
        for _, ps in ipairs(states) do cachePlayerState(ps) end
    end
end

local function guidEquals(a, b)
    if not a or not b then return false end
    local ok, equal = pcall(function()
        return a.A == b.A and a.B == b.B and a.C == b.C and a.D == b.D
    end)
    return ok and equal == true
end

local function resolvePlayerInventory(playerState)
    if not valid(playerState) then return nil, "invalid_player_state" end

    local fastOk, fastInventory = pcall(function()
        return playerState:GetInventoryData()
    end)
    if fastOk and valid(fastInventory) then
        local uid = getUid(playerState)
        if uid ~= "" then inventoryCacheByUid[uid] = fastInventory end
        return fastInventory, "player_state"
    end

    local uidOk, playerUid = pcall(function() return playerState.PlayerUId end)
    if not uidOk or not playerUid then return nil, "missing_player_uid" end
    local uidKey = guidToString(playerUid)
    local cached = inventoryCacheByUid[uidKey]
    if valid(cached) then return cached, "cache" end
    inventoryCacheByUid[uidKey] = nil

    local inventories = nil
    local listOk = pcall(function() inventories = FindAllOf("PalPlayerInventoryData") end)
    if listOk and inventories then
        for _, inventory in ipairs(inventories) do
            if valid(inventory) then
                local ownerOk, ownerUid = pcall(function() return inventory.OwnerPlayerUId end)
                if ownerOk and guidEquals(ownerUid, playerUid) then
                    inventoryCacheByUid[uidKey] = inventory
                    return inventory, "owner_uid"
                end
            end
        end
    end
    return nil, "inventory_not_ready"
end

local function resolvePlayerInventoryWithRetry(playerState, attempt, callback)
    local inventory, source = resolvePlayerInventory(playerState)
    if inventory then return callback(inventory, source) end
    local delays = { 500, 1000, 2000 }
    if attempt >= #delays then return callback(nil, source) end
    ExecuteWithDelay(delays[attempt + 1], function()
        ExecuteInGameThread(function()
            resolvePlayerInventoryWithRetry(playerState, attempt + 1, callback)
        end)
    end)
end

local function collectPlayers(emitTransitions)
    local rows = {}
    local seen = {}
    for cacheKey, ps in pairs(playerStatesCache) do
        if valid(ps) then
            local name = getPlayerName(ps)
            local uid = getUid(ps)
            local pawn = getPawn(ps)
            local loc = getLocation(pawn)
            if name ~= "" and loc then
                local key = uid ~= "" and uid or name
                seen[key] = true
                rows[#rows + 1] = {
                    type = "Character",
                    unitType = "Player",
                    nickName = name,
                    userId = uid,
                    class = getClassName(pawn),
                    pawn = getFullName(pawn),
                    x = loc.x, y = loc.y, z = loc.z,
                    isActive = true
                }
                if emitTransitions and not playerCache[key] then
                    emitEvent("join", { playerName = name, userId = uid })
                end
                playerCache[key] = { playerName = name, userId = uid }
            end
        else
            playerStatesCache[cacheKey] = nil
        end
    end
    if emitTransitions then
        for key, old in pairs(playerCache) do
            if not seen[key] then
                emitEvent("leave", { playerName = old.playerName, userId = old.userId })
                inventoryCacheByUid[old.userId] = nil
                playerCache[key] = nil
            end
        end
    end
    return rows
end

local function updatePlayers()
    local rows = collectPlayers(true)
    local payload = {
        version = VERSION,
        updatedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
        playerCount = #rows,
        actors = rows
    }
    local ok, err = atomicWrite(ACTORS_PATH, jsonValue(payload))
    if not ok then log("actors.json write failed: " .. tostring(err)) end
end

local function classifyCharacter(fullName, className, controllerName)
    local s = (className .. " " .. fullName .. " " .. controllerName):lower()
    if s:find("bp_player_", 1, true) or s:find("palplayercharacter", 1, true) then return "Player" end
    if s:find("basecamp", 1, true) or s:find("worker", 1, true) then return "BaseCampPal" end
    if s:find("otomo", 1, true) or s:find("partner", 1, true) then return "OtomoPal" end
    if s:find("human", 1, true) or s:find("npc", 1, true) then return "NPC" end
    if s:find("wild", 1, true) then return "WildPal" end
    return "WildPal"
end

local worldCharacterCache = {}
local baseCampCache = {}

local function objectKey(obj)
    local ok, addr = pcall(function() return obj:GetAddress() end)
    if ok and addr then return tostring(addr) end
    return getFullName(obj)
end

local function cacheWorldCharacter(actor)
    if not valid(actor) then return end
    local key = objectKey(actor)
    if key and key ~= "" then worldCharacterCache[key] = actor end
end

local function cacheBaseCamp(base)
    if not valid(base) then return end
    local key = objectKey(base)
    if key and key ~= "" then baseCampCache[key] = base end
end

local function rescanWorldCaches()
    local chars = nil
    pcall(function() chars = FindAllOf("PalCharacter") end)
    if chars then for _, actor in ipairs(chars) do cacheWorldCharacter(actor) end end

    local bases = nil
    pcall(function() bases = FindAllOf("PalBaseCampModel") end)
    if bases then for _, base in ipairs(bases) do cacheBaseCamp(base) end end
end

local function updateWorld()
    local rows = {}
    for key, actor in pairs(worldCharacterCache) do
        if valid(actor) then
            local loc = getLocation(actor)
            if loc then
                local fullName = getFullName(actor)
                local className = getClassName(actor)
                local controllerName = getControllerFullName(actor)
                local unit = classifyCharacter(fullName, className, controllerName)
                if unit ~= "Player" then
                    rows[#rows + 1] = {
                        type = "Character",
                        unitType = unit,
                        class = className,
                        fullName = fullName,
                        controller = controllerName,
                        level = getCharacterLevel(actor),
                        x = loc.x, y = loc.y, z = loc.z,
                        isActive = true
                    }
                end
            end
        else
            worldCharacterCache[key] = nil
        end
    end

    for key, base in pairs(baseCampCache) do
        if valid(base) then
            local loc = getBaseLocation(base)
            if loc then
                local range = nil
                local level = nil
                pcall(function() range = tonumber(base:GetRange()) end)
                pcall(function() level = tonumber(base:GetLevel()) end)
                rows[#rows + 1] = {
                    type = "PalBox",
                    unitType = "BaseCamp",
                    nickName = getBaseName(base),
                    instanceId = getBaseGuid(base, "GetId", "ID"),
                    guildId = getBaseGuid(base, "GetGroupIdBelongTo", "GroupIdBelongTo"),
                    level = level,
                    range = range,
                    x = loc.x, y = loc.y, z = loc.z,
                    isActive = true
                }
            end
        else
            baseCampCache[key] = nil
        end
    end

    local payload = {
        version = VERSION,
        updatedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
        count = #rows,
        actors = rows
    }
    local ok, err = atomicWrite(WORLD_PATH, jsonValue(payload))
    if not ok then log("world.json write failed: " .. tostring(err)) end
end

local function writeHeartbeat()
    local payload = {
        loaded = true,
        version = VERSION,
        timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ"),
        features = {
            players = true,
            playerPositions = true,
            listPlayers = true,
            chat = true,
            events = true,
            giveItems = true,
            personalMessage = true,
            announce = true,
            teleport = true,
            setTime = true,
            spawnPal = true,
            deaths = true,
            worldCharacters = true,
            bases = true
        }
    }
    atomicWrite(HEARTBEAT_PATH, jsonValue(payload))
end

local function writeState(extra)
    local state = {
        version = VERSION,
        ready = true,
        timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    }
    if extra then for k, v in pairs(extra) do state[k] = v end end
    atomicWrite(STATE_PATH, jsonValue(state))
end

local function findPlayer(target, allowRescan)
    local rawWanted = tostring(target or ""):lower()
    local wanted = rawWanted:gsub("%-", "")
    if wanted == "" then return nil end

    -- A PlayerState observed directly from the player's controller/chat hook is
    -- preferred over broad FindAllOf results, which can include stale objects.
    local direct = activePlayerStatesByName[rawWanted]
    if valid(direct) then
        return direct, getPlayerName(direct), getUid(direct)
    end

    local partial = nil
    for _, ps in pairs(playerStatesCache) do
        if valid(ps) then
            local name = getPlayerName(ps)
            local uid = getUid(ps)
            local lname = name:lower()
            local luid = uid:lower():gsub("%-", "")
            if lname == wanted or luid == wanted then return ps, name, uid end
            if not partial and lname:find(wanted, 1, true) then partial = { ps, name, uid } end
        end
    end
    if partial then return partial[1], partial[2], partial[3] end
    if allowRescan ~= false then
        rescanPlayerStates()
        return findPlayer(target, false)
    end
    return nil
end

local function sendResponse(id, success, message, data)
    local payload = {
        id = tostring(id or ""),
        success = success == true,
        message = tostring(message or ""),
        timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    }
    if data ~= nil then payload.data = data end
    atomicWrite(RESPONSE_PATH, jsonValue(payload))
end

local function doListPlayers(cmd)
    local players = {}
    for _, ps in pairs(playerStatesCache) do
        if valid(ps) then
            local name = getPlayerName(ps)
            local uid = getUid(ps)
            local pawn = getPawn(ps)
            local loc = getLocation(pawn)
            if name ~= "" then
                players[#players + 1] = {
                    playerName = name,
                    userId = uid,
                    x = loc and loc.x or nil,
                    y = loc and loc.y or nil,
                    z = loc and loc.z or nil
                }
            end
        end
    end
    return true, string.format("%d player(s)", #players), { players = players }
end

local function doGetPosition(cmd)
    local target = cmd.playerName or cmd.player or cmd.userId
    local ps, name, uid = findPlayer(target)
    if not ps then return false, "player not found: " .. tostring(target) end
    local pawn = getPawn(ps)
    local loc = getLocation(pawn)
    if not loc then return false, "player pawn/location unavailable" end
    return true, "position found", { playerName = name, userId = uid, x = loc.x, y = loc.y, z = loc.z }
end

local function doGiveItem(cmd, inventory)
    local target = cmd.playerName or cmd.player or cmd.userId
    local ps, name, uid = findPlayer(target)
    if not ps then return false, "player not found: " .. tostring(target) end
    local item = tostring(cmd.itemId or cmd.item or "")
    local qty = math.floor(tonumber(cmd.quantity or cmd.count or 1) or 1)
    if item == "" or qty < 1 or qty > 1000000 then return false, "invalid item/quantity" end
    if not valid(inventory) then return false, "inventory_not_ready" end
    local callOk, callErr = pcall(function()
        -- Palworld 1.0.5 server signature (verified against live UE4SS reflection):
        -- AddItem_ServerInternal(FName StaticItemId, int Count, bool IsAssignPassive, float LogDelay, bool bNotifyLog)
        inventory:AddItem_ServerInternal(FName(item), qty, false, 0.0, true)
    end)
    if not callOk then return false, "AddItem_ServerInternal failed: " .. tostring(callErr) end
    emitEvent("delivery", { playerName = name, userId = uid, itemId = item, quantity = qty })
    return true, string.format("gave %d x %s to %s", qty, item, name)
end

local function doGiveItems(cmd, inventory)
    local items = cmd.items
    if type(items) ~= "table" or #items == 0 then return false, "items array required" end
    local delivered = 0
    for _, entry in ipairs(items) do
        local child = {
            playerName = cmd.playerName,
            player = cmd.player,
            userId = cmd.userId,
            itemId = entry.itemId or entry.ItemID or entry.item,
            quantity = entry.quantity or entry.Count or entry.count
        }
        local ok, msg = doGiveItem(child, inventory)
        if not ok then return false, msg .. string.format(" (after %d item entries)", delivered) end
        delivered = delivered + 1
    end
    return true, string.format("delivered %d item entries", delivered)
end

local function makeChatMessage(message, receivers)
    return {
        Category = 0,
        Sender = "PalControl",
        SenderPlayerUId = { A = 0, B = 0, C = 0, D = 0 },
        Message = tostring(message or ""),
        ReceiverPlayerUIds = receivers or {},
        MessageId = FName("None"),
        MessageArgKeys = {},
        MessageArgValues = {}
    }
end

local function broadcastChat(message, receivers)
    local gs = FindFirstOf("PalGameStateInGame")
    if not valid(gs) then return false, "PalGameStateInGame unavailable" end
    local ok, err = pcall(function()
        gs:BroadcastChatMessage(makeChatMessage(message, receivers))
    end)
    if not ok then return false, tostring(err) end
    return true
end

local function doAnnounce(cmd)
    local message = tostring(cmd.message or "")
    if message == "" then return false, "message required" end

    local sent, err = false, nil
    local util = StaticFindObject("/Script/Pal.Default__PalUtility")
    local world = FindFirstOf("World")
    if valid(util) and valid(world) then
        local ok, utilityErr = pcall(function() util:SendSystemAnnounce(world, message) end)
        if ok then sent = true else err = tostring(utilityErr) end
    end
    if not sent then sent, err = broadcastChat(message, {}) end
    if not sent then return false, "announcement unavailable: " .. tostring(err or "unknown") end

    local gs = FindFirstOf("PalGameStateInGame")
    if valid(gs) then pcall(function() gs:BroadcastServerNotice(message) end) end
    emitEvent("announce", { message = message })
    return true, "announcement sent"
end

local function doPersonalMessage(cmd)
    local target = cmd.playerName or cmd.player or cmd.userId
    local ps, name, uid = findPlayer(target)
    if not ps then return false, "player not found: " .. tostring(target) end
    local message = tostring(cmd.message or "")
    if message == "" then return false, "message required" end

    local okUid, playerUid = pcall(function() return ps.PlayerUId end)
    if not okUid or not playerUid then return false, "PlayerUId unavailable" end
    local translated = guidParts(playerUid)
    if not translated then return false, "PlayerUId translation failed" end

    local sent, err = false, nil
    local util = StaticFindObject("/Script/Pal.Default__PalUtility")
    local world = FindFirstOf("World")
    if valid(util) and valid(world) then
        local ok, utilityErr = pcall(function()
            util:SendSystemToPlayerChat(world, message, { translated })
        end)
        if ok then sent = true else err = tostring(utilityErr) end
    end
    if not sent then sent, err = broadcastChat(message, { translated }) end
    if not sent then return false, "private message unavailable: " .. tostring(err or "unknown") end
    emitEvent("personal_message", { playerName = name, userId = uid, message = message })
    return true, "personal message sent"
end

local function doTeleport(cmd)
    local target = cmd.playerName or cmd.player or cmd.userId
    local ps, name, uid = findPlayer(target)
    if not ps then return false, "player not found: " .. tostring(target) end
    local x, y, z = tonumber(cmd.x), tonumber(cmd.y), tonumber(cmd.z)
    if not x or not y or not z then return false, "x/y/z required" end
    local pawn = getPawn(ps)
    if not pawn then return false, "player pawn unavailable" end
    pawn:K2_TeleportTo({ X = x, Y = y, Z = z }, { Pitch = 0, Yaw = 0, Roll = 0 })
    emitEvent("teleport", { playerName = name, userId = uid, x = x, y = y, z = z })
    return true, "teleported " .. name
end

local function doKill(cmd)
    local target = cmd.playerName or cmd.player or cmd.userId
    local ps, name, uid = findPlayer(target)
    if not ps then return false, "player not found: " .. tostring(target) end
    local pc = getController(ps)
    if not pc then return false, "player controller unavailable" end
    pc:SelfKillPlayer()
    emitEvent("admin_kill", { playerName = name, userId = uid })
    return true, "killed " .. name
end

local function doSetTime(cmd)
    local hour = math.floor(tonumber(cmd.hour) or -1)
    if hour < 0 or hour > 23 then return false, "hour must be 0-23" end
    local tm = FindFirstOf("PalTimeManager")
    if not valid(tm) then return false, "PalTimeManager unavailable" end
    tm:SetGameTime_FixDay(hour)
    emitEvent("set_time", { hour = hour })
    return true, "time set to " .. tostring(hour)
end

local function doSpawnPal(cmd)
    local palId = tostring(cmd.palId or cmd.pal or "")
    local level = math.floor(tonumber(cmd.level or 1) or 1)
    if palId == "" or level < 1 then return false, "palId/level required" end

    local target = cmd.playerName or cmd.player or cmd.userId
    if not target or tostring(target) == "" then
        return false, "target player required"
    end

    local ps, name, uid = findPlayer(target)
    if not ps then
        return false, "player not found: " .. tostring(target)
    end

    -- IMPORTANT:
    -- Do NOT use CheatManager here. On this dedicated server that path can
    -- wedge the UE4SS Lua/game thread, which stops heartbeat, welcome messages
    -- and item/kit delivery.
    --
    -- PalPlayerState exposes:
    -- RequestSpawnMonsterForPlayer(FName CharacterID, int32 Num, int32 Level)
    --
    -- processCommandFile already invokes this handler inside ExecuteInGameThread(),
    -- so there is deliberately no nested ExecuteInGameThread here.
    local callOk, callErr = pcall(function()
        ps:RequestSpawnMonsterForPlayer(FName(palId), 1, level)
    end)

    if not callOk then
        return false, "RequestSpawnMonsterForPlayer failed: " .. tostring(callErr)
    end

    emitEvent("spawn_pal_request", {
        palId = palId,
        level = level,
        playerName = name,
        userId = uid,
        method = "PalPlayerState.RequestSpawnMonsterForPlayer"
    })

    return true,
        string.format("requested %s level %d for %s", palId, level, name),
        {
            palId = palId,
            level = level,
            playerName = name,
            userId = uid,
            method = "PalPlayerState.RequestSpawnMonsterForPlayer"
        }
end

local ACTIONS = {
    ping = function(cmd) return true, "pong", { version = VERSION } end,
    list_players = doListPlayers,
    get_position = doGetPosition,
    announce = doAnnounce,
    personal_message = doPersonalMessage,
    teleport = doTeleport,
    kill_player = doKill,
    set_time = doSetTime,
    spawn_pal = doSpawnPal
}

local commandBusy = false
local function executeCommandOnGameThread(action, callback)
    if action == "spawn_pal" and EngineTickAvailable and EGameThreadMethod then
        ExecuteInGameThread(callback, EGameThreadMethod.EngineTick)
        return
    end
    ExecuteInGameThread(callback)
end

local function processItemCommand(cmd, id)
    local target = cmd.playerName or cmd.player or cmd.userId
    local playerState, playerName = findPlayer(target)
    if not playerState then
        sendResponse(id, false, "player not found: " .. tostring(target))
        commandBusy = false
        return
    end
    local inventoryOk, inventory = pcall(function()
        return playerState:GetInventoryData()
    end)
    if not inventoryOk or not inventory then
        sendResponse(id, false, "GetInventoryData unavailable: " .. tostring(inventory))
        commandBusy = false
        return
    end
    local ok, message
    if cmd.action == "give_item" then
        ok, message = doGiveItem(cmd, inventory)
    else
        ok, message = doGiveItems(cmd, inventory)
    end
    sendResponse(id, ok, message, { inventorySource = "player_state_direct" })
    commandBusy = false
end

local function processCommandFile()
    if commandBusy then return end
    local raw = readFile(COMMAND_PATH)
    if not raw then return end
    commandBusy = true
    os.remove(COMMAND_PATH)
    local okDecode, cmd = pcall(decodeJson, raw)
    if not okDecode or type(cmd) ~= "table" then
        sendResponse("", false, "invalid command JSON: " .. tostring(cmd))
        commandBusy = false
        return
    end
    local id = tostring(cmd.id or "")
    local action = tostring(cmd.action or "")
    local handler = ACTIONS[action]
    if not handler then
        if action == "give_item" or action == "give_items" then
            executeCommandOnGameThread(action, function() processItemCommand(cmd, id) end)
            return
        end
        sendResponse(id, false, "unsupported action: " .. action)
        commandBusy = false
        return
    end
    executeCommandOnGameThread(action, function()
        local okAction, success, message, data = pcall(function()
            local a, b, c = handler(cmd)
            return a, b, c
        end)
        if not okAction then
            sendResponse(id, false, "action exception: " .. tostring(success))
        else
            sendResponse(id, success == true, message, data)
        end
        commandBusy = false
    end)
end

local function safeRegisterHook(path, handler, retryMs)
    local ok, err = pcall(function() RegisterHook(path, handler) end)
    if ok then
        log("hook registered: " .. path)
        return
    end
    log("hook not ready: " .. path .. " -> " .. tostring(err))
    ExecuteWithDelay(retryMs or 3000, function() safeRegisterHook(path, handler, retryMs) end)
end

local notifyRegistered = {}
local function safeNotifyOnNewObject(classPath, handler, retryMs)
    if notifyRegistered[classPath] then return end
    local ok, err = pcall(function()
        NotifyOnNewObject(classPath, function(obj)
            local handled, handlerErr = pcall(handler, obj)
            if not handled then log("object notification handler error: " .. classPath .. " -> " .. tostring(handlerErr)) end
        end)
    end)
    if ok then
        notifyRegistered[classPath] = true
        log("object notification registered: " .. classPath)
        return
    end
    log("object notification not ready: " .. classPath .. " -> " .. tostring(err))
    ExecuteWithDelay(retryMs or 3000, function() safeNotifyOnNewObject(classPath, handler, retryMs) end)
end

local function chatHook(ctx, Message, Category)
    local ok, err = pcall(function()
        local pc = ctx and ctx:get() or nil
        if not valid(pc) then return end
        local ps = pc.PlayerState
        if valid(ps) then cachePlayerState(ps) end
        local text = Message and Message:get():ToString() or ""
        local category = Category and Category:get() or nil
        local name = valid(ps) and getPlayerName(ps) or "Unknown"
        local uid = valid(ps) and getUid(ps) or ""
        if text == "" then return end
        emitEvent("chat", {
            playerName = name,
            userId = uid,
            category = tonumber(category) or tostring(category or ""),
            message = text,
            isCommand = text:sub(1, 1) == "!" or text:sub(1, 1) == "/"
        })
    end)
    if not ok then log("chat hook error: " .. tostring(err)) end
end

-- A dedicated player-character hook gives fast join visibility; polling still acts as fallback.
local function characterInitHook(ctx)
    ExecuteWithDelay(100, function()
        pcall(function()
            local character = ctx and ctx:get() or nil
            if not valid(character) then return end
            local ps = character.PlayerState
            if valid(ps) then
                cachePlayerState(ps)
                emitEvent("character_init", { playerName = getPlayerName(ps), userId = getUid(ps) })
                updatePlayers()
            end
        end)
    end)
end

local function deathHook(ctx)
    pcall(function()
        local character = ctx and ctx:get() or nil
        if not valid(character) then return end
        local fullName = getFullName(character)
        local className = getClassName(character)
        local ps = nil
        pcall(function() ps = character.PlayerState end)
        if valid(ps) then
            emitEvent("death", { kind = "player", playerName = getPlayerName(ps), userId = getUid(ps), class = className })
        else
            emitEvent("death", { kind = "character", class = className, fullName = fullName })
        end
    end)
end

log("Loading v" .. VERSION .. " from " .. MOD_DIR)
writeHeartbeat()
writeState({ status = "booting" })

ExecuteWithDelay(1500, function()
    safeRegisterHook("/Script/Pal.PalPlayerController:EnterChat_Receive", chatHook, 3000)
    safeRegisterHook("/Script/Pal.PalPlayerCharacter:OnCompleteInitializeParameter", characterInitHook, 3000)
    safeRegisterHook("/Script/Pal.PalCharacter:OnDeadCharacter", deathHook, 3000)
    safeNotifyOnNewObject("/Script/Pal.PalPlayerState", cachePlayerState, 3000)
    safeNotifyOnNewObject("/Script/Pal.PalCharacter", cacheWorldCharacter, 3000)
    safeNotifyOnNewObject("/Script/Pal.PalBaseCampModel", cacheBaseCamp, 3000)
end)

ExecuteWithDelay(3000, function()
    ExecuteInGameThread(function()
        rescanPlayerStates()
        rescanWorldCaches()
        updatePlayers()
        updateWorld()
        writeHeartbeat()
        writeState({ status = "ready" })
    end)
end)

LoopAsync(PLAYER_REFRESH_MS, function()
    ExecuteInGameThread(updatePlayers)
    return false
end)

LoopAsync(PLAYER_RESCAN_MS, function()
    ExecuteInGameThread(rescanPlayerStates)
    return false
end)

LoopAsync(WORLD_REFRESH_MS, function()
    ExecuteInGameThread(updateWorld)
    return false
end)

LoopAsync(WORLD_RESCAN_MS, function()
    ExecuteInGameThread(rescanWorldCaches)
    return false
end)

LoopAsync(HEARTBEAT_MS, function()
    writeHeartbeat()
    return false
end)

LoopAsync(COMMAND_POLL_MS, function()
    processCommandFile()
    return false
end)

log("READY v" .. VERSION)
