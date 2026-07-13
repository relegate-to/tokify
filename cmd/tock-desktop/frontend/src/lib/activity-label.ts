type VerbMatch = {
    text?: string;
    terms?: TermMatch[];
    verb?: {
        root?: string;
        auxiliary?: string;
        infinitive?: string;
        grammar?: {
            copula?: boolean;
        };
    };
};

type TopicMatch = {
    text?: string;
    terms?: TermMatch[];
    noun?: {
        root?: string;
    };
};

type TermMatch = {
    index?: [number, number];
};

type CompromiseDoc = {
    verbs: () => { json: () => VerbMatch[] };
    topics: () => { out: (format: 'array') => string[] };
    nouns: () => { json: () => TopicMatch[] };
};

type Nlp = (text: string) => CompromiseDoc;

const MAX_VERBS = 2;
const GENERIC_TOPIC_SUFFIXES = ['activity title', 'activity name', 'title', 'name'];

export function activityTitle(
    description?: string | null,
    project?: string | null,
) {
    return description?.trim() || project?.trim() || 'Activity';
}

export async function buildActivityShorthandTitle(title: string) {
    const { default: nlp } = (await import('compromise')) as { default: Nlp };
    return shorthandActivityTitle(title, nlp);
}

function shorthandActivityTitle(title: string, nlp: Nlp) {
    const source = normalize(title);
    if (!source) return 'Activity';

    const doc = nlp(source);
    const nounMatches = doc.nouns().json() as TopicMatch[];
    const firstNounIndex = firstTermIndex(nounMatches[0]);
    const verbs = extractVerbs(doc.verbs().json() as VerbMatch[], firstNounIndex);

    const topic = extractTopic(doc, nounMatches);
    if (!verbs.length) return topic || source;
    if (!topic) return verbs.join('/');

    const label = titleCase(`${verbs.join('/')} ${topic}`);
    return label.length < source.length ? label : source;
}

function extractVerbs(matches: VerbMatch[], firstNounIndex: number) {
    const verbs = matches
        .filter((match) => !match.verb?.grammar?.copula && !match.verb?.auxiliary)
        .filter((match) => {
            const index = firstTermIndex(match);
            return index === Number.POSITIVE_INFINITY || index < firstNounIndex;
        })
        .map((match) => normalize(match.verb?.root || match.text || ''))
        .filter(Boolean)
        .slice(0, MAX_VERBS);

    if (verbs.length) return verbs;

    return matches
        .filter((match) => !match.verb?.grammar?.copula && !match.verb?.auxiliary)
        .map((match) => normalize(match.verb?.root || match.text || ''))
        .filter(Boolean)
        .slice(0, 1);
}

function extractTopic(doc: CompromiseDoc, nounMatches: TopicMatch[]) {
    const topics = doc.topics().out('array');
    const nouns = nounMatches.map(topicText);
    const candidates = [...topics, ...nouns].map(cleanTopic).filter(Boolean);

    return candidates.at(-1) || '';
}

function firstTermIndex(match?: { terms?: TermMatch[] }) {
    return match?.terms?.[0]?.index?.[1] ?? Number.POSITIVE_INFINITY;
}

function topicText(match: TopicMatch) {
    const text = cleanTopic(match.text || '');
    const root = cleanTopic(match.noun?.root || '');

    if (root && !text.toLowerCase().includes(' of ') && root.length <= text.length) {
        return root;
    }

    return text || root;
}

function cleanTopic(topic: string) {
    let value = normalize(topic).replace(/^(?:a|an|the)\s+/i, '');

    for (const suffix of GENERIC_TOPIC_SUFFIXES) {
        const pattern = new RegExp(`\\s+${suffix}$`, 'i');
        value = value.replace(pattern, '');
    }

    return value;
}

function normalize(value: string) {
    return value.trim().replace(/\s+/g, ' ');
}

function titleCase(value: string) {
    return value.replace(/\p{L}[\p{L}'-]*/gu, (word) => {
        const [first = '', ...rest] = word;
        return first.toLocaleUpperCase() + rest.join('').toLocaleLowerCase();
    });
}
