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

function formatReleaseHeading(release: ChangelogRelease): string {
	let heading = `## [${release.version}]`;
	if (release.date) {
		heading += ` - ${release.date}`;
	}
	if (release.codename) {
		heading += ` (${release.codename})`;
	}
	return heading;
}

/**
 * Map raw CHANGELOG.md into display markdown: custom intro + released versions only.
 * Drops Unreleased, file boilerplate, and anything outside version sections.
 */
export function mapChangelogToDisplayMarkdown(
	markdown: string,
	changelogUrl: string,
): string {
	const releases = parseChangelogReleases(markdown).filter(
		(release) => !isUnreleased(release.version),
	);

	const intro = `This page is generated on demand from the project's [CHANGELOG.md](${changelogUrl}) on GitHub.`;

	if (releases.length === 0) {
		return intro;
	}

	const sections = releases.map((release) => {
		const heading = formatReleaseHeading(release);
		if (!release.bodyMarkdown) {
			return heading;
		}
		return `${heading}\n\n${release.bodyMarkdown}`;
	});

	return `${intro}\n\n${sections.join("\n\n")}\n`;
}
