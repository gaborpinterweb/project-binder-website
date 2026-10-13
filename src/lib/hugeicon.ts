type IconNode = [string, Record<string, string | number>];

function toAttrName(name: string): string {
	return name.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/** Convert a Hugeicons icon node array into SVG inner markup. */
export function hugeIconHtml(icon: IconNode[]): string {
	return icon
		.map(([tag, attrs]) => {
			const attrString = Object.entries(attrs)
				.filter(([key]) => key !== "key")
				.map(([key, value]) => `${toAttrName(key)}="${value}"`)
				.join(" ");
			return `<${tag} ${attrString} />`;
		})
		.join("");
}
