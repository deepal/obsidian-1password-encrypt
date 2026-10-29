import obsidianmd from "eslint-plugin-obsidianmd";
export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: { "obsidianmd/ui/sentence-case": ["warn", { ignoreWords: ["1Password", "IDs", "ID"] }] },
		languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
	},
];
