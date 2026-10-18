import { App, type CachedMetadata, type Pos } from "obsidian";

const smallHeadingBoundary = /^[^\r\n]*<\/small>[ \t]*\r?\n(?= {0,3}#{1,6}[ \t]+\S)/gim;

export function hasSmallHeadingBoundary(text: string): boolean {
    smallHeadingBoundary.lastIndex = 0;
    return smallHeadingBoundary.test(text);
}

// Map metadata positions from the parsing copy back to the unchanged manuscript.
function originalPosition(position: Pos, insertedOffsets: number[]): Pos {
    const originalLocation = (location: Pos["start"]) => {
        const insertedBefore = insertedOffsets.filter(offset => offset < location.offset).length;
        return {
            ...location,
            line: location.line - insertedBefore,
            offset: location.offset - insertedBefore,
        };
    };
    return {
        start: originalLocation(position.start),
        end: originalLocation(position.end),
    };
}

// Parse headings after multiline <small> recaps without changing the note itself.
export async function parseMetaDataCache(
    app: App,
    text: string,
): Promise<CachedMetadata> {
    const original = await app.metadataCache.computeMetadataAsync(
        new TextEncoder().encode(text).buffer,
    );
    if (!hasSmallHeadingBoundary(text)) return original;

    smallHeadingBoundary.lastIndex = 0;
    const boundaries = Array.from(text.matchAll(smallHeadingBoundary), match => {
        const offset = match.index + match[0].length;
        return { offset, line: text.slice(0, offset).split("\n").length - 1 };
    }).filter(({ offset, line }) =>
        !original.headings?.some(heading => heading.position.start.line === line)
        && original.sections?.some(section => section.type === "html"
            && section.position.start.offset <= offset
            && section.position.end.offset >= offset),
    );
    if (boundaries.length === 0) return original;

    let normalized = text;
    for (const { offset } of [...boundaries].reverse()) {
        normalized = normalized.slice(0, offset) + "\n" + normalized.slice(offset);
    }
    const insertedOffsets = boundaries.map(({ offset }, index) => offset + index);
    const parsed = await app.metadataCache.computeMetadataAsync(
        new TextEncoder().encode(normalized).buffer,
    );
    return {
        ...original,
        headings: parsed.headings?.map(heading => ({
            ...heading,
            position: originalPosition(heading.position, insertedOffsets),
        })),
        sections: parsed.sections?.map(section => ({
            ...section,
            position: originalPosition(section.position, insertedOffsets),
        })),
    };
}

type Content = {
    preContent: string;
    children: Section[];
};
type Section = {
    id: number;
    heading: string;
    headingLevel: number; // 1-based
    headingExpaned: boolean;
    content: Content;
    type: "section";
};

export async function parseMarkdown(text: string, app: App): Promise<Section> {
    const res = await parseMetaDataCache(app, text);
    const headings = res.headings || [];
    const sections = res.sections || [];

    const content: Content = {
        preContent: "",
        children: [],
    };

    const stack: Section[] = [
        {
            heading: "",
            headingLevel: 0,
            headingExpaned: false,
            id: -1,
            content,
            type: "section",
        },
    ];

    let start = 0,
        end = 0,
        headingIndex = 0;
    for (const section of sections) {
        if (section.type === "heading") {
            end = Math.max(section.position.start.offset, 0);
            stack.last()!.content.preContent = text.slice(start, end);

            while (headings[headingIndex].level <= stack.last()!.headingLevel) {
                stack.pop();
            }

            const newEntry: Section = {
                heading: headings[headingIndex].heading,
                headingLevel: headings[headingIndex].level,
                headingExpaned: false,
                id: headingIndex,
                content: {
                    preContent: "",
                    children: [],
                },
                type: "section",
            };
            stack.last()!.content.children.push(newEntry);
            stack.push(newEntry);

            start = headings[headingIndex].position.end.offset + 1;
            headingIndex++;
        }
    }

    // make sure the last section ends with a `\n`,
    // so that it won't stick to any other sections
    let preContent = text.slice(start);
    if (stack.length > 1 && !preContent.endsWith("\n")) {
        preContent += "\n";
    }

    stack.last()!.content.preContent = preContent;
    return stack[0];
}

export function moveHeading(
    root: Section,
    fromNo: number,
    toNo: number,
    position: "before" | "after" | "inside",
) {
    const [fromParent, from] = findSection(root, fromNo);
    const [toParent, to] = findSection(root, toNo);
    const newFrom = structuredClone(from);

    switch (position) {
        case "before":
            toParent.content.children.splice(
                toParent.content.children.indexOf(to),
                0,
                newFrom,
            );
            modifyHeadingLevel(newFrom, to.headingLevel - from.headingLevel);
            break;
        case "after":
            toParent.content.children.splice(
                toParent.content.children.indexOf(to) + 1,
                0,
                newFrom,
            );
            modifyHeadingLevel(newFrom, to.headingLevel - from.headingLevel);
            break;
        case "inside":
            to.content.children.push(newFrom);
            modifyHeadingLevel(
                newFrom,
                to.headingLevel - from.headingLevel + 1,
            );
            break;
    }
    fromParent.content.children.splice(
        fromParent.content.children.indexOf(from),
        1,
    );
}

export function removeHeading(root: Section, toRemoveNo: number) {
    const [parent, toRemove] = findSection(root, toRemoveNo);
    parent.content.children.splice(
        parent.content.children.indexOf(toRemove),
        1,
    );
}

export function findSection(root: Section, id: number): [Section, Section] {
    const res = findSectionIn(root, root, id);
    if (!res) {
        throw new Error(`section ${id} not found`);
    }
    return res;
}

function findSectionIn(
    root: Section,
    parent: Section,
    id: number,
): [Section, Section] | undefined {
    if (root.id === id) return [parent, root];

    for (const child of root.content.children) {
        const res = findSectionIn(child, root, id);
        if (res) return res;
    }
}

export function visitSection(root: Section, fn: (section: Section) => void) {
    fn(root);

    for (const child of root.content.children) {
        visitSection(child, fn);
    }
}

function stringifyContent(content: Content): string {
    return content.preContent + content.children.map(stringifySection).join("");
}

export function stringifySection(section: Section): string {
    const heading = "#".repeat(section.headingLevel) + " " + section.heading;
    const content = stringifyContent(section.content);

    return section.id < 0 ? content : `${heading}\n${content}`;
}

function modifyHeadingLevel(section: Section, delta: number) {
    section.headingLevel += delta;
    section.content.children.forEach((child) => {
        modifyHeadingLevel(child, delta);
    });
}
