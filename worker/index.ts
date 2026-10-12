const REPO = "gaborpinterweb/project-binder";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK = `https://github.com/${REPO}/releases/latest`;
const CACHE_TTL_SECONDS = 600;

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
			"User-Agent": "project-binder-website",
		},
	});

	const cached = await cache.match(cacheKey);
	if (cached?.ok) {
		return (await cached.json()) as Release;
	}

	const response = await fetch(LATEST_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "project-binder-website",
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

		return env.ASSETS.fetch(request);
	},
};
