const REPO = "gaborpinterweb/project-binder";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK = `https://github.com/${REPO}/releases/latest`;
const CACHE_TTL_SECONDS = 600;
const CONFIRM_TTL_SECONDS = 48 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_BASE = "https://api.resend.com";
const USER_AGENT = "project-binder-website";

type Platform = "macos" | "windows";

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface Release {
	assets: ReleaseAsset[];
}

interface Env {
	ASSETS: Fetcher;
	RESEND_API_KEY: string;
	RESEND_SEGMENT_ID: string;
	RESEND_FROM: string;
	CONFIRM_SECRET: string;
	RESEND_TOPIC_ID?: string;
}

interface ResendContact {
	id: string;
	email: string;
	unsubscribed: boolean;
}

function isPlatform(value: string | null): value is Platform {
	return value === "macos" || value === "windows";
}

function matchesPlatform(name: string, platform: Platform): boolean {
	const lower = name.toLowerCase();
	if (platform === "macos") {
		return lower.includes("mac");
	}
	return lower.includes("win") || lower.includes("windows");
}

function pickAsset(assets: ReleaseAsset[], platform: Platform): ReleaseAsset | null {
	const matches = assets.filter((asset) => matchesPlatform(asset.name, platform));
	if (matches.length === 0) return null;

	if (platform === "macos") {
		const arm64 = matches.find((asset) => asset.name.toLowerCase().includes("arm64"));
		if (arm64) return arm64;
	}

	return matches[0] ?? null;
}

async function fetchLatestRelease(): Promise<Release | null> {
	const cache = caches.default;
	const cacheKey = new Request(LATEST_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": USER_AGENT,
		},
	});

	const cached = await cache.match(cacheKey);
	if (cached?.ok) {
		return (await cached.json()) as Release;
	}

	const response = await fetch(LATEST_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": USER_AGENT,
		},
	});

	if (!response.ok) return null;

	const toCache = new Response(response.clone().body, response);
	toCache.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);
	void cache.put(cacheKey, toCache.clone());

	return (await response.json()) as Release;
}

function redirect(url: string): Response {
	return Response.redirect(url, 302);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function newsletterConfigured(env: Env): boolean {
	return Boolean(
		env.RESEND_API_KEY && env.RESEND_SEGMENT_ID && env.RESEND_FROM && env.CONFIRM_SECRET,
	);
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array | string): string {
	const data =
		typeof bytes === "string"
			? new TextEncoder().encode(bytes)
			: bytes instanceof Uint8Array
				? bytes
				: new Uint8Array(bytes);
	let binary = "";
	for (const byte of data) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	const binary = atob(padded + pad);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function createConfirmToken(email: string, secret: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + CONFIRM_TTL_SECONDS;
	const payload = `${email.toLowerCase()}|${exp}`;
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}

async function verifyConfirmToken(
	token: string,
	secret: string,
): Promise<{ email: string } | null> {
	const [payloadPart, signaturePart] = token.split(".");
	if (!payloadPart || !signaturePart) return null;

	const payloadBytes = fromBase64Url(payloadPart);
	const signatureBytes = fromBase64Url(signaturePart);
	const key = await hmacKey(secret);
	const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, payloadBytes);
	if (!valid) return null;

	const payload = new TextDecoder().decode(payloadBytes);
	const [email, expRaw] = payload.split("|");
	const exp = Number(expRaw);
	if (!email || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
		return null;
	}

	return { email: email.toLowerCase() };
}

async function resendFetch(
	env: Env,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${env.RESEND_API_KEY}`);
	headers.set("User-Agent", USER_AGENT);
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}

	return fetch(`${RESEND_BASE}${path}`, { ...init, headers });
}

async function getContact(env: Env, email: string): Promise<ResendContact | null> {
	const response = await resendFetch(env, `/contacts/${encodeURIComponent(email)}`);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`Failed to look up contact (${response.status})`);
	}
	return (await response.json()) as ResendContact;
}

async function createPendingContact(env: Env, email: string): Promise<void> {
	const body: Record<string, unknown> = {
		email,
		unsubscribed: true,
		segments: [{ id: env.RESEND_SEGMENT_ID }],
	};

	const response = await resendFetch(env, "/contacts", {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (response.ok) return;

	const errorText = await response.text();
	// Already exists: caller should fall back to get + resend
	if (response.status === 409 || /already exists|duplicate/i.test(errorText)) {
		return;
	}

	throw new Error(`Failed to create contact (${response.status}): ${errorText}`);
}

async function addContactToSegment(env: Env, email: string): Promise<void> {
	const response = await resendFetch(
		env,
		`/contacts/${encodeURIComponent(email)}/segments/${env.RESEND_SEGMENT_ID}`,
		{ method: "POST" },
	);
	if (response.ok || response.status === 409) return;
	const errorText = await response.text();
	throw new Error(`Failed to add contact to segment (${response.status}): ${errorText}`);
}

async function confirmContact(env: Env, email: string): Promise<void> {
	const updateResponse = await resendFetch(env, `/contacts/${encodeURIComponent(email)}`, {
		method: "PATCH",
		body: JSON.stringify({ unsubscribed: false }),
	});
	if (!updateResponse.ok) {
		const errorText = await updateResponse.text();
		throw new Error(`Failed to confirm contact (${updateResponse.status}): ${errorText}`);
	}

	await addContactToSegment(env, email);

	if (env.RESEND_TOPIC_ID) {
		const topicsResponse = await resendFetch(
			env,
			`/contacts/${encodeURIComponent(email)}/topics`,
			{
				method: "PATCH",
				body: JSON.stringify([
					{ id: env.RESEND_TOPIC_ID, subscription: "opt_in" },
				]),
			},
		);
		if (!topicsResponse.ok) {
			const errorText = await topicsResponse.text();
			throw new Error(`Failed to opt in topic (${topicsResponse.status}): ${errorText}`);
		}
	}
}

async function sendConfirmEmail(
	env: Env,
	email: string,
	confirmUrl: string,
): Promise<void> {
	const html = `
<div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; color: #111; max-width: 32rem; margin: 0 auto; padding: 2rem 1rem;">
  <h1 style="font-size: 1.5rem; margin: 0 0 1rem;">Confirm your subscription</h1>
  <p style="margin: 0 0 1.5rem;">Click the button below to confirm you want Project Binder news.</p>
  <p style="margin: 0 0 1.5rem;">
    <a href="${confirmUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font-weight: 600;">Confirm subscription</a>
  </p>
  <p style="margin: 0; font-size: 0.875rem; color: #555;">If you did not request this, you can ignore this email.</p>
</div>`.trim();

	const response = await resendFetch(env, "/emails", {
		method: "POST",
		body: JSON.stringify({
			from: env.RESEND_FROM,
			to: [email],
			subject: "Confirm your Project Binder subscription",
			html,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Failed to send confirmation email (${response.status}): ${errorText}`);
	}
}

async function parseSubscribeBody(
	request: Request,
): Promise<{ email: string; company: string }> {
	const contentType = request.headers.get("Content-Type") ?? "";

	if (contentType.includes("application/json")) {
		const body = (await request.json()) as { email?: unknown; company?: unknown };
		return {
			email: typeof body.email === "string" ? body.email.trim() : "",
			company: typeof body.company === "string" ? body.company.trim() : "",
		};
	}

	const form = await request.formData();
	const emailValue = form.get("email");
	const companyValue = form.get("company");
	return {
		email: typeof emailValue === "string" ? emailValue.trim() : "",
		company: typeof companyValue === "string" ? companyValue.trim() : "",
	};
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return json({ ok: false, error: "Method not allowed" }, 405);
	}

	if (!newsletterConfigured(env)) {
		return json({ ok: false, error: "Newsletter is not configured" }, 500);
	}

	const { email, company } = await parseSubscribeBody(request);

	// Honeypot: bots fill hidden fields; humans leave them empty.
	if (company) {
		return json({ ok: true, message: "Check your email to confirm" });
	}

	const normalized = email.toLowerCase();
	if (!normalized || normalized.length > 254 || !EMAIL_RE.test(normalized)) {
		return json({ ok: false, error: "Enter a valid email address" }, 400);
	}

	try {
		const existing = await getContact(env, normalized);
		if (existing && !existing.unsubscribed) {
			return json({ ok: true, message: "You are already subscribed" });
		}

		if (!existing) {
			await createPendingContact(env, normalized);
			// create may no-op on race/duplicate; ensure we can still proceed
			const created = await getContact(env, normalized);
			if (!created) {
				return json({ ok: false, error: "Could not create subscription" }, 500);
			}
		} else {
			await addContactToSegment(env, normalized);
		}

		const token = await createConfirmToken(normalized, env.CONFIRM_SECRET);
		const origin = new URL(request.url).origin;
		const confirmUrl = `${origin}/api/confirm?token=${encodeURIComponent(token)}`;
		await sendConfirmEmail(env, normalized, confirmUrl);

		return json({ ok: true, message: "Check your email to confirm" });
	} catch (error) {
		console.error("subscribe failed", error);
		return json({ ok: false, error: "Something went wrong. Try again." }, 500);
	}
}

async function handleConfirm(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const home = `${url.origin}/?newsletter=confirmed#final-cta`;
	const invalid = `${url.origin}/?newsletter=invalid#final-cta`;

	if (request.method !== "GET") {
		return redirect(invalid);
	}

	if (!newsletterConfigured(env)) {
		return redirect(invalid);
	}

	const token = url.searchParams.get("token");
	if (!token) {
		return redirect(invalid);
	}

	try {
		const verified = await verifyConfirmToken(token, env.CONFIRM_SECRET);
		if (!verified) {
			return redirect(invalid);
		}

		await confirmContact(env, verified.email);
		return redirect(home);
	} catch (error) {
		console.error("confirm failed", error);
		return redirect(invalid);
	}
}

async function handleDownload(request: Request): Promise<Response> {
	const platformParam = new URL(request.url).searchParams.get("platform");
	if (!isPlatform(platformParam)) {
		return redirect(FALLBACK);
	}

	try {
		const release = await fetchLatestRelease();
		if (!release?.assets?.length) {
			return redirect(FALLBACK);
		}

		const asset = pickAsset(release.assets, platformParam);
		if (!asset?.browser_download_url) {
			return redirect(FALLBACK);
		}

		return redirect(asset.browser_download_url);
	} catch {
		return redirect(FALLBACK);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/download") {
			return handleDownload(request);
		}

		if (url.pathname === "/api/subscribe") {
			return handleSubscribe(request, env);
		}

		if (url.pathname === "/api/confirm") {
			return handleConfirm(request, env);
		}

		return env.ASSETS.fetch(request);
	},
};
