import fs from "node:fs";
import path from "node:path";
import wordListPath from "word-list";

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, "shared", "wordLists.ts");

const words = fs
  .readFileSync(wordListPath, "utf8")
  .split("\n")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean);

const filteredWords = words.filter(
  (word) => /^[a-z]+$/.test(word) && (word.length === 4 || word.length === 5) && new Set(word).size === word.length
);

const fourLetterWords = filteredWords.filter((word) => word.length === 4);
const fiveLetterWords = filteredWords.filter((word) => word.length === 5);

const content = `export const FOUR_LETTER_WORDS = ${JSON.stringify(fourLetterWords, null, 2)};

export const FIVE_LETTER_WORDS = ${JSON.stringify(fiveLetterWords, null, 2)};
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, content, "utf8");

console.log(
  `Generated ${fourLetterWords.length} four-letter words and ${fiveLetterWords.length} five-letter words at ${outputPath}`
);
