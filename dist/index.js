"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_crypto_1 = require("node:crypto");
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const supabase_js_1 = require("@supabase/supabase-js");
const socket_io_1 = require("socket.io");
const zod_1 = require("zod");
const game_1 = require("./game");
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    PORT: zod_1.z.coerce.number().int().min(1).max(65535).default(5000),
    CORS_ORIGINS: zod_1.z.string().default("http://localhost:3000,http://127.0.0.1:5500"),
    SUPABASE_URL: zod_1.z.string().url(),
    SUPABASE_ANON_KEY: zod_1.z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: zod_1.z.string().min(1),
    DEV_ADMIN_KEY: zod_1.z.string().min(32).optional(),
    DEMO_CREDITS_ENABLED: zod_1.z.enum(["true", "false"]).default("false")
});
const config = envSchema.parse(process.env);
const userClient = (0, supabase_js_1.createClient)(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});
const serviceClient = (0, supabase_js_1.createClient)(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});
const allowDemoSpins = config.NODE_ENV !== "production" || config.DEMO_CREDITS_ENABLED === "true";
const app = (0, express_1.default)();
const origins = config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
app.disable("x-powered-by");
app.use((0, helmet_1.default)({ contentSecurityPolicy: false }));
app.use((0, cors_1.default)({ origin: origins, credentials: true }));
app.use(express_1.default.json({ limit: "16kb" }));
app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", demoCreditsOnly: true });
});
const credentialsSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(254),
    password: zod_1.z.string().min(8).max(128),
    username: zod_1.z.string().trim().min(2).max(32).optional()
});
app.post("/api/auth/signup", async (request, response, next) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Invalid signup details." });
        return;
    }
    try {
        const { data, error } = await userClient.auth.signUp({
            email: parsed.data.email,
            password: parsed.data.password,
            options: { data: { username: parsed.data.username ?? parsed.data.email } }
        });
        if (error) {
            response.status(400).json({ error: error.message });
            return;
        }
        response.status(201).json({
            userId: data.user?.id,
            accessToken: data.session?.access_token ?? null,
            confirmationRequired: !data.session
        });
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/auth/login", async (request, response, next) => {
    const parsed = credentialsSchema.pick({ email: true, password: true }).safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Invalid login details." });
        return;
    }
    try {
        const { data, error } = await userClient.auth.signInWithPassword(parsed.data);
        if (error || !data.session || !data.user) {
            response.status(401).json({ error: error?.message ?? "Unable to authenticate." });
            return;
        }
        response.json({ userId: data.user.id, accessToken: data.session.access_token });
    }
    catch (error) {
        next(error);
    }
});
async function authenticatedUser(request) {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer "))
        return null;
    const token = authorization.slice("Bearer ".length);
    const { data, error } = await userClient.auth.getUser(token);
    return error ? null : data.user;
}
app.get("/api/profile", async (request, response, next) => {
    try {
        const user = await authenticatedUser(request);
        if (!user) {
            response.status(401).json({ error: "Authentication required." });
            return;
        }
        const [profileResult, walletResult] = await Promise.all([
            serviceClient.from("profiles").select("username, created_at").eq("id", user.id).single(),
            serviceClient.from("demo_wallets")
                .select("balance_cents, total_wagered_cents, total_returned_cents, free_spins_remaining")
                .eq("user_id", user.id).single()
        ]);
        if (profileResult.error)
            throw profileResult.error;
        if (walletResult.error)
            throw walletResult.error;
        response.json({
            userId: user.id,
            username: profileResult.data.username || user.email || "Player",
            createdAt: profileResult.data.created_at,
            balance: (0, game_1.credits)(Number(walletResult.data.balance_cents)),
            totalWagered: (0, game_1.credits)(Number(walletResult.data.total_wagered_cents)),
            totalReturned: (0, game_1.credits)(Number(walletResult.data.total_returned_cents)),
            freeSpinsRemaining: walletResult.data.free_spins_remaining,
            currency: "DEMO",
            redeemable: false
        });
    }
    catch (error) {
        next(error);
    }
});
function decimalCreditsToCents(value) {
    if (typeof value !== "string" || !/^-?\d{1,7}(?:\.\d{1,2})?$/.test(value))
        return null;
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ""] = unsigned.split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return negative ? -cents : cents;
}
app.get("/admin", (request, response) => {
    if (config.NODE_ENV !== "development" || !config.DEV_ADMIN_KEY) {
        response.sendStatus(404);
        return;
    }
    response.sendFile("admin_index.html", { root: process.cwd() });
});
function requireDevelopmentAdmin(request, response) {
    if (config.NODE_ENV !== "development" || !config.DEV_ADMIN_KEY) {
        response.sendStatus(404);
        return false;
    }
    if (request.header("x-dev-admin-key") !== config.DEV_ADMIN_KEY) {
        response.status(401).json({ error: "Invalid development admin key." });
        return false;
    }
    return true;
}
app.get("/api/dev/users", async (request, response, next) => {
    if (!requireDevelopmentAdmin(request, response))
        return;
    try {
        const { data, error } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 100 });
        if (error)
            throw error;
        const userIds = data.users.map((user) => user.id);
        const [profiles, wallets] = userIds.length === 0
            ? [{ data: [], error: null }, { data: [], error: null }]
            : await Promise.all([
                serviceClient.from("profiles").select("id, username, created_at").in("id", userIds),
                serviceClient.from("demo_wallets")
                    .select("user_id, balance_cents, free_spins_remaining").in("user_id", userIds)
            ]);
        if (profiles.error)
            throw profiles.error;
        if (wallets.error)
            throw wallets.error;
        const profileById = new Map(profiles.data.map((profile) => [profile.id, profile]));
        const walletById = new Map(wallets.data.map((wallet) => [wallet.user_id, wallet]));
        response.json({
            users: data.users.map((user) => {
                const profile = profileById.get(user.id);
                const wallet = walletById.get(user.id);
                return {
                    id: user.id,
                    email: user.email,
                    username: profile?.username || user.user_metadata.username || user.email || "Player",
                    createdAt: profile?.created_at ?? user.created_at,
                    enabled: !user.banned_until || Date.parse(user.banned_until) <= Date.now(),
                    balance: wallet ? (0, game_1.credits)(Number(wallet.balance_cents)) : null,
                    freeSpins: wallet?.free_spins_remaining ?? 0
                };
            })
        });
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/dev/users", async (request, response, next) => {
    if (!requireDevelopmentAdmin(request, response))
        return;
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Provide a valid email, password (8+ characters), and optional username." });
        return;
    }
    let createdUserId;
    try {
        const username = parsed.data.username ?? parsed.data.email;
        const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
            email: parsed.data.email,
            password: parsed.data.password,
            email_confirm: true,
            user_metadata: { username }
        });
        if (createError)
            throw createError;
        if (!created.user)
            throw new Error("Supabase did not return the created user.");
        createdUserId = created.user.id;
        const tokenClient = (0, supabase_js_1.createClient)(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data: sessionData, error: sessionError } = await tokenClient.auth.signInWithPassword({
            email: parsed.data.email,
            password: parsed.data.password
        });
        if (sessionError || !sessionData.session) {
            throw sessionError ?? new Error("Unable to issue a Unity test session.");
        }
        response.status(201).json({
            user: {
                id: created.user.id,
                email: created.user.email,
                username,
                enabled: true
            },
            accessToken: sessionData.session.access_token,
            expiresAt: sessionData.session.expires_at
        });
    }
    catch (error) {
        if (createdUserId) {
            const { error: deleteError } = await serviceClient.auth.admin.deleteUser(createdUserId);
            if (deleteError) {
                console.error("Could not roll back partially created demo account:", deleteError);
            }
        }
        next(error);
    }
});
app.patch("/api/dev/users/:userId/status", async (request, response, next) => {
    if (!requireDevelopmentAdmin(request, response))
        return;
    const userId = zod_1.z.string().uuid().safeParse(request.params.userId);
    const enabled = zod_1.z.boolean().safeParse(request.body?.enabled);
    if (!userId.success || !enabled.success) {
        response.status(400).json({ error: "Provide a valid user ID and enabled boolean." });
        return;
    }
    try {
        const { data, error } = await serviceClient.auth.admin.updateUserById(userId.data, {
            ban_duration: enabled.data ? "none" : "876000h"
        });
        if (error)
            throw error;
        response.json({
            userId: data.user.id,
            enabled: !data.user.banned_until || Date.parse(data.user.banned_until) <= Date.now()
        });
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/dev/demo-credits", async (request, response, next) => {
    if (!requireDevelopmentAdmin(request, response))
        return;
    const userId = zod_1.z.string().uuid().safeParse(request.body?.userId);
    const deltaCents = decimalCreditsToCents(request.body?.deltaCredits);
    if (!userId.success || deltaCents === null || deltaCents === 0) {
        response.status(400).json({ error: "Provide a user UUID and non-zero amount with at most two decimals." });
        return;
    }
    try {
        const { data, error } = await serviceClient.rpc("adjust_demo_credits", {
            p_user_id: userId.data,
            p_delta_cents: deltaCents,
            p_reference_id: (0, node_crypto_1.randomUUID)()
        });
        if (error)
            throw error;
        response.json({ balance: (0, game_1.credits)(Number(data)), currency: "DEMO", redeemable: false });
    }
    catch (error) {
        next(error);
    }
});
const httpServer = app.listen(config.PORT, () => {
    console.log(`Demo backend listening on port ${config.PORT} (${config.NODE_ENV})`);
});
const io = new socket_io_1.Server(httpServer, {
    cors: { origin: origins, credentials: true },
    transports: ["websocket", "polling"]
});
const spinSchema = zod_1.z.object({
    id: zod_1.z.literal("SPIN"),
    data: zod_1.z.object({
        currentBet: zod_1.z.number().int().min(0).max(game_1.BETS_CENTS.length - 1),
        currentLines: zod_1.z.number().int().refine((lines) => lines === game_1.LINE_COUNT),
        spins: zod_1.z.number().int().refine((spins) => spins === 1),
        requestId: zod_1.z.string().uuid(),
        isFreeSpin: zod_1.z.boolean().default(false)
    })
});
io.use(async (socket, next) => {
    const auth = socket.handshake.auth;
    if (!auth.token || auth.gameId !== "SL-CRZ") {
        next(new Error("Valid token and gameId are required."));
        return;
    }
    try {
        const { data, error } = await userClient.auth.getUser(auth.token);
        if (error || !data.user) {
            next(new Error("Invalid or expired access token."));
            return;
        }
        if (data.user.banned_until && Date.parse(data.user.banned_until) > Date.now()) {
            next(new Error("This demo player account is disabled."));
            return;
        }
        socket.data.user = data.user;
        next();
    }
    catch (error) {
        next(error instanceof Error ? error : new Error("Socket authentication failed."));
    }
});
io.on("connection", (socket) => {
    if (!allowDemoSpins) {
        socket.emit("internalError", { message: "Demo spins are disabled in production." });
        socket.disconnect(true);
        return;
    }
    void sendInitialData(socket, socket.data.user).catch((error) => {
        console.error("Socket initialization failed:", error);
        socket.emit("internalError", { message: "Unable to load player data." });
        socket.disconnect(true);
    });
    socket.on("message", (raw) => {
        if (raw === "YES I AM ALIVE")
            return;
        if (raw === "EXIT") {
            socket.emit("message", { id: "ExitUser" });
            socket.disconnect(true);
            return;
        }
        void handleSpinMessage(socket, raw).catch((error) => {
            console.error("Spin request failed:", error);
            socket.emit("internalError", { message: "Spin could not be completed." });
        });
    });
});
async function sendInitialData(socket, user) {
    const [profileResult, walletResult] = await Promise.all([
        serviceClient.from("profiles").select("username").eq("id", user.id).single(),
        serviceClient.from("demo_wallets")
            .select("balance_cents, free_spins_remaining").eq("user_id", user.id).single()
    ]);
    if (profileResult.error)
        throw profileResult.error;
    if (walletResult.error)
        throw walletResult.error;
    const root = {
        id: "InitData",
        username: profileResult.data.username || user.email || "Player",
        message: {
            GameData: {
                Bets: game_1.BETS_CENTS.map(game_1.credits),
                autoSpin: [10],
                resultSymbols: [],
                isFreeSpin: false,
                freeSpinCount: walletResult.data.free_spins_remaining
            },
            UIData: {
                paylines: { symbols: game_1.SYMBOLS },
                spclSymbolTxt: [],
                AbtLogo: { logoSprite: "", link: "" },
                ToULink: "",
                PopLink: ""
            },
            PlayerData: {
                Balance: (0, game_1.credits)(Number(walletResult.data.balance_cents)),
                haveWon: 0,
                currentWining: 0,
                totalbet: 0
            }
        }
    };
    socket.emit("message", root);
}
async function handleSpinMessage(socket, raw) {
    let parsedJson;
    try {
        parsedJson = typeof raw === "string" ? JSON.parse(raw) : raw;
    }
    catch {
        socket.emit("internalError", { message: "Invalid JSON spin request." });
        return;
    }
    const parsed = spinSchema.safeParse(parsedJson);
    if (!parsed.success) {
        socket.emit("internalError", { message: "Invalid spin request fields." });
        return;
    }
    const message = parsed.data;
    const user = socket.data.user;
    const betPerLineCents = game_1.BETS_CENTS[message.data.currentBet];
    const outcome = (0, game_1.createDemoOutcome)(betPerLineCents);
    const { data, error } = await serviceClient.rpc("play_demo_spin", {
        p_user_id: user.id,
        p_request_id: message.data.requestId,
        p_bet_index: message.data.currentBet,
        p_result_symbols: outcome.resultSymbols,
        p_is_free_spin: message.data.isFreeSpin
    });
    if (error) {
        const detail = error.code === "22003"
            ? "Insufficient demo credits or no free spins remain."
            : "The spin was not accepted. No credits were charged.";
        socket.emit("message", { id: "SpinError", message: { error: detail } });
        return;
    }
    if (Number(data.payoutCents) !== outcome.payoutCents ||
        Number(data.freeSpinCount) !== outcome.freeSpinAward) {
        throw new Error("Database outcome did not match the server-calculated result.");
    }
    const result = data;
    socket.emit("message", {
        id: "ResultData",
        message: {
            GameData: {
                Bets: game_1.BETS_CENTS.map(game_1.credits),
                autoSpin: [10],
                resultSymbols: result.resultSymbols,
                isFreeSpin: result.isFreeSpin,
                freeSpinCount: result.freeSpinCount
            },
            PlayerData: {
                Balance: (0, game_1.credits)(result.balanceCents),
                haveWon: (0, game_1.credits)(result.totalReturnedCents),
                currentWining: (0, game_1.credits)(result.payoutCents),
                totalbet: (0, game_1.credits)(result.totalWageredCents)
            }
        }
    });
}
app.use((error, _request, response, _next) => {
    console.error("Request failed:", error);
    response.status(500).json({ error: "The request could not be completed." });
});
process.on("SIGINT", () => {
    io.close();
    httpServer.close();
});
