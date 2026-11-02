const RELEASE_HEADING_RE =
	/^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?(?:\s+\(([^)]+)\))?/;

export interface ChangelogRelease {
	version: string;
	date: string | null;
	codename: string | null;
	bodyMarkdown: string;
}

/** Split Keep a Changelog markdown into versioned release sections. */
export function parseChangelogReleases(markdown: string): ChangelogRelease[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const releases: ChangelogRelease[] = [];
	let current: ChangelogRelease | null = null;
	const bodyLines: string[] = [];

	const flush = () => {
		if (!current) return;
		current.bodyMarkdown = bodyLines.join("\n").trim();
		releases.push(current);
		current = null;
		bodyLines.length = 0;
	};

	for (const line of lines) {
		const match = line.match(RELEASE_HEADING_RE);
		if (match) {
			flush();
			current = {
				version: match[1]!.trim(),
				date: match[2] ?? null,
				codename: match[3]?.trim() ?? null,
				bodyMarkdown: "",
			};
			continue;
		}

		if (current) {
			bodyLines.push(line);
		}
	}

	flush();
	return releases;
}

function isUnreleased(version: string): boolean {
	return version.trim().toLowerCase() === "unreleased";
}

function formatReleaseTitle(release: ChangelogRelease): string {
	let title = release.version;
	if (release.codename) {
		title += ` (${release.codename})`;
	}
	if (release.date) {
		title += ` on ${release.date}`;
	}
	return title;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Inline markdown: links, backticks, then escape the rest. */
function renderInlineMarkdown(text: string): string {
	const parts: string[] = [];
	const tokenRe = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tokenRe.exec(text)) !== null) {
		if (match.index > lastIndex) {
			parts.push(escapeHtml(text.slice(lastIndex, match.index)));
		}

		const code = match[1];
		const link = match[2];
		if (code) {
			parts.push(`<code>${escapeHtml(code.slice(1, -1))}</code>`);
		} else if (link) {
			const linkMatch = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
			if (linkMatch) {
				const label = escapeHtml(linkMatch[1]!);
				const href = escapeHtml(linkMatch[2]!);
				parts.push(
					`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
				);
			} else {
				parts.push(escapeHtml(link));
			}
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		parts.push(escapeHtml(text.slice(lastIndex)));
	}

	return parts.join("");
}

/** Render Keep a Changelog body subset: h3, lists, paragraphs. */
export function renderChangelogBodyHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const html: string[] = [];
	let inList = false;
	let paragraph: string[] = [];

	const closeList = () => {
		if (!inList) return;
		html.push("</ul>");
		inList = false;
	};

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
		paragraph = [];
	};

	for (const line of lines) {
		const heading = line.match(/^###\s+(.+)$/);
		if (heading) {
			closeList();
			flushParagraph();
			html.push(`<h3>${escapeHtml(heading[1]!.trim())}</h3>`);
			continue;
		}

		const listItem = line.match(/^-\s+(.+)$/);
		if (listItem) {
			flushParagraph();
			if (!inList) {
				html.push("<ul>");
				inList = true;
			}
			html.push(`<li>${renderInlineMarkdown(listItem[1]!)}</li>`);
			continue;
		}

		if (line.trim() === "") {
			closeList();
			flushParagraph();
			continue;
		}

		closeList();
		paragraph.push(line.trim());
	}

	closeList();
	flushParagraph();
	return html.join("\n");
}

/**
 * Map raw CHANGELOG.md into display HTML: custom intro + released versions only.
 * Drops Unreleased, file boilerplate, and anything outside version sections.
 */
export function mapChangelogToDisplayHtml(
	markdown: string,
	changelogUrl: string,
): string {
	const releases = parseChangelogReleases(markdown).filter(
		(release) => !isUnreleased(release.version),
	);

	const href = escapeHtml(changelogUrl);
	const intro = `<p>A short history of what is new, fixed, or improved in each Project Binder release. This page is built on demand from the project's <a href="${href}" target="_blank" rel="noopener noreferrer">CHANGELOG.md</a> on GitHub.</p>`;

	if (releases.length === 0) {
		return intro;
	}

	const sections = releases.map((release) => {
		const title = escapeHtml(formatReleaseTitle(release));
		const body = release.bodyMarkdown
			? `\n${renderChangelogBodyHtml(release.bodyMarkdown)}`
			: "";
		return `<article class="changelog-release"><h2>${title}</h2>${body}</article>`;
	});

	return `${intro}\n<div class="changelog-releases">\n${sections.join("\n")}\n</div>`;
}
