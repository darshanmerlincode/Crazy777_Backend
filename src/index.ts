import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { createClient, User } from "@supabase/supabase-js";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import { BETS_CENTS, createDemoOutcome, credits, LINE_COUNT, SYMBOLS } from "./game";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEV_ADMIN_KEY: z.string().min(32).optional(),
  DEMO_CREDITS_ENABLED: z.enum(["true", "false"]).default("false")
});

const config = envSchema.parse(process.env);
const userClient = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const serviceClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const allowDemoSpins = config.NODE_ENV !== "production" || config.DEMO_CREDITS_ENABLED === "true";
const app = express();
const PERMANENT_TOKEN_PREFIX = "c777_dev_";

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", demoCreditsOnly: true });
});

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  username: z.string().trim().min(2).max(32).optional()
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
  } catch (error) {
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
  } catch (error) {
    next(error);
  }
});

async function authenticatedUser(request: Request): Promise<User | null> {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
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
    if (profileResult.error) throw profileResult.error;
    if (walletResult.error) throw walletResult.error;
    response.json({
      userId: user.id,
      username: profileResult.data.username || user.email || "Player",
      createdAt: profileResult.data.created_at,
      balance: credits(Number(walletResult.data.balance_cents)),
      totalWagered: credits(Number(walletResult.data.total_wagered_cents)),
      totalReturned: credits(Number(walletResult.data.total_returned_cents)),
      freeSpinsRemaining: walletResult.data.free_spins_remaining,
      currency: "DEMO",
      redeemable: false
    });
  } catch (error) {
    next(error);
  }
});

function decimalCreditsToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?\d{1,7}(?:\.\d{1,2})?$/.test(value)) return null;
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
  response.sendFile("index.html", { root: process.cwd() });
});

function requireDevelopmentAdmin(request: Request, response: Response): boolean {
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
  if (!requireDevelopmentAdmin(request, response)) return;
  try {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (error) throw error;
    const userIds = data.users.map((user) => user.id);
    const [profiles, wallets, tokens] = userIds.length === 0
      ? [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
      : await Promise.all([
        serviceClient.from("profiles").select("id, username, created_at").in("id", userIds),
        serviceClient.from("demo_wallets")
          .select("user_id, balance_cents, free_spins_remaining").in("user_id", userIds),
        serviceClient.from("dev_socket_tokens")
          .select("user_id").in("user_id", userIds).is("revoked_at", null)
      ]);
    if (profiles.error) throw profiles.error;
    if (wallets.error) throw wallets.error;
    if (tokens.error) throw tokens.error;

    const profileById = new Map(profiles.data.map((profile) => [profile.id, profile]));
    const walletById = new Map(wallets.data.map((wallet) => [wallet.user_id, wallet]));
    const usersWithPermanentTokens = new Set(tokens.data.map((token) => token.user_id));
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
          balance: wallet ? credits(Number(wallet.balance_cents)) : null,
          freeSpins: wallet?.free_spins_remaining ?? 0,
          hasPermanentToken: usersWithPermanentTokens.has(user.id)
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dev/users", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;
  const parsed = credentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Provide a valid email, password (8+ characters), and optional username." });
    return;
  }
  let createdUserId: string | undefined;
  try {
    const username = parsed.data.username ?? parsed.data.email;
    const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
      user_metadata: { username }
    });
    if (createError) throw createError;
    if (!created.user) throw new Error("Supabase did not return the created user.");
    createdUserId = created.user.id;

    const tokenClient = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
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
  } catch (error) {
    if (createdUserId) {
      const { error: deleteError } = await serviceClient.auth.admin.deleteUser(createdUserId);
      if (deleteError) {
        console.error("Could not roll back partially created demo account:", deleteError);
      }
    }
    next(error);
  }
});

app.post("/api/dev/users/:userId/token", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;
  const userId = z.string().uuid().safeParse(request.params.userId);
  if (!userId.success) {
    response.status(400).json({ error: "Provide a valid user ID." });
    return;
  }

  try {
    const { data: userData, error: userError } =
      await serviceClient.auth.admin.getUserById(userId.data);
    if (userError) throw userError;
    if (!userData.user?.email) {
      response.status(404).json({ error: "Player has no email address." });
      return;
    }
    if (userData.user.banned_until && Date.parse(userData.user.banned_until) > Date.now()) {
      response.status(409).json({ error: "Enable this player before issuing a test token." });
      return;
    }

    const { data: linkData, error: linkError } =
      await serviceClient.auth.admin.generateLink({
        type: "magiclink",
        email: userData.user.email
      });
    if (linkError) throw linkError;
    if (!linkData.properties.hashed_token) {
      throw new Error("Supabase did not return a token for the test session.");
    }

    const tokenClient = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: sessionData, error: sessionError } = await tokenClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink"
    });
    if (sessionError || !sessionData.session) {
      throw sessionError ?? new Error("Unable to issue a Unity test session.");
    }

    response.json({
      userId: userData.user.id,
      accessToken: sessionData.session.access_token,
      expiresAt: sessionData.session.expires_at
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dev/users/:userId/permanent-token", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;
  const userId = z.string().uuid().safeParse(request.params.userId);
  if (!userId.success) {
    response.status(400).json({ error: "Provide a valid user ID." });
    return;
  }
  try {
    const { data, error } = await serviceClient.auth.admin.getUserById(userId.data);
    if (error) throw error;
    if (!data.user) {
      response.status(404).json({ error: "Player not found." });
      return;
    }
    if (data.user.banned_until && Date.parse(data.user.banned_until) > Date.now()) {
      response.status(409).json({ error: "Enable this player before issuing a permanent development token." });
      return;
    }

    const token = `${PERMANENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const { error: rotateError } = await serviceClient.rpc("rotate_dev_socket_token", {
      p_user_id: userId.data,
      p_token_hash: tokenHash
    });
    if (rotateError) throw rotateError;
    io.in(userId.data).disconnectSockets(true);
    response.json({
      userId: userId.data,
      accessToken: token,
      expiresAt: null,
      tokenType: "permanent-development"
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dev/users/:userId/permanent-token", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;
  const userId = z.string().uuid().safeParse(request.params.userId);
  if (!userId.success) {
    response.status(400).json({ error: "Provide a valid user ID." });
    return;
  }
  try {
    const { error } = await serviceClient.rpc("revoke_dev_socket_token", {
      p_user_id: userId.data
    });
    if (error) throw error;
    io.in(userId.data).disconnectSockets(true);
    response.json({ userId: userId.data, revoked: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/dev/users/:userId/status", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;
  const userId = z.string().uuid().safeParse(request.params.userId);
  const enabled = z.boolean().safeParse(request.body?.enabled);
  if (!userId.success || !enabled.success) {
    response.status(400).json({ error: "Provide a valid user ID and enabled boolean." });
    return;
  }
  try {
    const { data, error } = await serviceClient.auth.admin.updateUserById(userId.data, {
      ban_duration: enabled.data ? "none" : "876000h"
    });
    if (error) throw error;
    if (!enabled.data) {
      const { error: revokeError } = await serviceClient.rpc("revoke_dev_socket_token", {
        p_user_id: userId.data
      });
      if (revokeError) throw revokeError;
    }
    io.in(userId.data).disconnectSockets(true);
    response.json({
      userId: data.user.id,
      enabled: !data.user.banned_until || Date.parse(data.user.banned_until) <= Date.now()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dev/demo-credits", async (request, response, next) => {
  if (!requireDevelopmentAdmin(request, response)) return;

  const userId = z.string().uuid().safeParse(request.body?.userId);
  const deltaCents = decimalCreditsToCents(request.body?.deltaCredits);
  if (!userId.success || deltaCents === null || deltaCents === 0) {
    response.status(400).json({ error: "Provide a user UUID and non-zero amount with at most two decimals." });
    return;
  }
  try {
    const { data, error } = await serviceClient.rpc("adjust_demo_credits", {
      p_user_id: userId.data,
      p_delta_cents: deltaCents,
      p_reference_id: randomUUID()
    });
    if (error) throw error;
    response.json({ balance: credits(Number(data)), currency: "DEMO", redeemable: false });
  } catch (error) {
    next(error);
  }
});

const httpServer = app.listen(config.PORT, () => {
  console.log(`Demo backend listening on port ${config.PORT} (${config.NODE_ENV})`);
});
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"]
});

interface ClientAuth {
  token?: string;
  gameId?: string;
}

interface SpinMessage {
  id: "SPIN";
  data: {
    currentBet: number;
    currentLines: number;
    spins: number;
    requestId: string;
    isFreeSpin: boolean;
  };
}

const spinSchema = z.object({
  id: z.literal("SPIN"),
  data: z.object({
    currentBet: z.number().int().min(0).max(BETS_CENTS.length - 1),
    currentLines: z.number().int().refine((lines) => lines === LINE_COUNT),
    spins: z.number().int().refine((spins) => spins === 1),
    requestId: z.string().uuid(),
    isFreeSpin: z.boolean().default(false)
  })
});

io.use(async (socket, next) => {
  const auth = socket.handshake.auth as ClientAuth;
  if (!auth.token || auth.gameId !== "SL-CRZ") {
    next(new Error("Valid token and gameId are required."));
    return;
  }
  try {
    let user: User | null;
    if (auth.token.startsWith(PERMANENT_TOKEN_PREFIX)) {
      if (config.NODE_ENV !== "development") {
        next(new Error("Permanent development tokens are disabled outside development."));
        return;
      }
      const tokenHash = createHash("sha256").update(auth.token).digest("hex");
      const { data: tokenRecord, error: tokenError } = await serviceClient
        .from("dev_socket_tokens")
        .select("user_id")
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .maybeSingle();
      if (tokenError) throw tokenError;
      if (!tokenRecord) {
        next(new Error("Invalid or revoked development token."));
        return;
      }
      const { data, error } = await serviceClient.auth.admin.getUserById(tokenRecord.user_id);
      if (error) throw error;
      user = data.user;
    } else {
      const { data, error } = await userClient.auth.getUser(auth.token);
      if (error) {
        next(new Error("Invalid or expired access token."));
        return;
      }
      user = data.user;
    }
    if (!user) {
      next(new Error("Player account not found."));
      return;
    }
    if (user.banned_until && Date.parse(user.banned_until) > Date.now()) {
      next(new Error("This demo player account is disabled."));
      return;
    }
    socket.data.user = user;
    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error("Socket authentication failed."));
  }
});

io.on("connection", (socket: Socket) => {
  if (!allowDemoSpins) {
    socket.emit("internalError", { message: "Demo spins are disabled in production." });
    socket.disconnect(true);
    return;
  }
  const user = socket.data.user as User;
  socket.join(user.id);
  void sendInitialData(socket, user).catch((error: unknown) => {
    console.error("Socket initialization failed:", error);
    socket.emit("internalError", { message: "Unable to load player data." });
    socket.disconnect(true);
  });

  socket.on("message", (raw: unknown) => {
    if (raw === "YES I AM ALIVE") return;
    if (raw === "EXIT") {
      socket.emit("message", { id: "ExitUser" });
      socket.disconnect(true);
      return;
    }
    void handleSpinMessage(socket, raw).catch((error: unknown) => {
      console.error("Spin request failed:", error);
      socket.emit("internalError", { message: "Spin could not be completed." });
    });
  });
});

async function sendInitialData(socket: Socket, user: User): Promise<void> {
  const [profileResult, walletResult] = await Promise.all([
    serviceClient.from("profiles").select("username").eq("id", user.id).single(),
    serviceClient.from("demo_wallets")
      .select("balance_cents, free_spins_remaining").eq("user_id", user.id).single()
  ]);
  if (profileResult.error) throw profileResult.error;
  if (walletResult.error) throw walletResult.error;
  const root = {
    id: "InitData",
    username: profileResult.data.username || user.email || "Player",
    message: {
      GameData: {
        Bets: BETS_CENTS.map(credits),
        autoSpin: [10],
        resultSymbols: [],
        isFreeSpin: false,
        freeSpinCount: walletResult.data.free_spins_remaining
      },
      UIData: {
        paylines: { symbols: SYMBOLS },
        spclSymbolTxt: [],
        AbtLogo: { logoSprite: "", link: "" },
        ToULink: "",
        PopLink: ""
      },
      PlayerData: {
        Balance: credits(Number(walletResult.data.balance_cents)),
        haveWon: 0,
        currentWining: 0,
        totalbet: 0
      }
    }
  };
  socket.emit("message", root);
}

async function handleSpinMessage(socket: Socket, raw: unknown): Promise<void> {
  let parsedJson: unknown;
  try {
    parsedJson = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    socket.emit("internalError", { message: "Invalid JSON spin request." });
    return;
  }
  const parsed = spinSchema.safeParse(parsedJson);
  if (!parsed.success) {
    socket.emit("internalError", { message: "Invalid spin request fields." });
    return;
  }
  const message: SpinMessage = parsed.data;
  const user = socket.data.user as User;
  const betPerLineCents = BETS_CENTS[message.data.currentBet];
  const outcome = createDemoOutcome(betPerLineCents);
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
  if (
    Number(data.payoutCents) !== outcome.payoutCents ||
    Number(data.freeSpinCount) !== outcome.freeSpinAward
  ) {
    throw new Error("Database outcome did not match the server-calculated result.");
  }

  const result = data as {
    balanceCents: number;
    wagerCents: number;
    payoutCents: number;
    resultSymbols: number[][];
    isFreeSpin: boolean;
    freeSpinCount: number;
    freeSpinsRemaining: number;
    totalWageredCents: number;
    totalReturnedCents: number;
    requestId: string;
  };

  socket.emit("message", {
    id: "ResultData",
    message: {
      GameData: {
        Bets: BETS_CENTS.map(credits),
        autoSpin: [10],
        resultSymbols: result.resultSymbols,
        isFreeSpin: result.isFreeSpin,
        freeSpinCount: result.freeSpinCount
      },
      PlayerData: {
        Balance: credits(result.balanceCents),
        haveWon: credits(result.totalReturnedCents),
        currentWining: credits(result.payoutCents),
        totalbet: credits(result.totalWageredCents)
      }
    }
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error("Request failed:", error);
  response.status(500).json({ error: "The request could not be completed." });
});

process.on("SIGINT", () => {
  io.close();
  httpServer.close();
});
