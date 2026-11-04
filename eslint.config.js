import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { deserialize, serialize } from 'node:v8';

if (globalThis.structuredClone === undefined) {
    globalThis.structuredClone = (value) => deserialize(serialize(value));
}

if (Array.prototype.findLast === undefined) {
    Object.defineProperty(Array.prototype, 'findLast', {
        configurable: true,
        value(predicate, thisArgument) {

            for (let index = this.length - 1; index >= 0; index--) {
                if (predicate.call(thisArgument, this[index], index, this)) {
                    return this[index];
                }
            }

            return undefined;
        },
        writable: true,
    });
}

const localRules = {
    rules: {
        'function-body-padding': {
            meta: {
                type: 'layout',
                fixable: 'whitespace',
                schema: [],
            },
            create(context) {

                const source = context.sourceCode;

                function check(node) {

                    if (node.body?.type !== 'BlockStatement' || node.body.body.length === 0) {
                        return;
                    }

                    const openingBrace = source.getFirstToken(node.body);
                    const firstStatement = node.body.body[0];
                    const lastStatement = node.body.body.at(-1);
                    const closingBrace = source.getLastToken(node.body);

                    if (firstStatement.loc.start.line - openingBrace.loc.end.line < 2) {
                        context.report({
                            node: firstStatement,
                            message: 'Add an empty line after the function opening brace.',
                            fix: (fixer) => fixer.insertTextAfter(openingBrace, '\n'),
                        });
                    }

                    if (closingBrace.loc.start.line - lastStatement.loc.end.line > 1) {
                        const lineStart = source.text.lastIndexOf('\n', closingBrace.range[0] - 1) + 1;
                        const indentation = source.text.slice(lineStart, closingBrace.range[0]);

                        context.report({
                            node: lastStatement,
                            message: 'Remove the empty line before the function closing brace.',
                            fix: (fixer) => fixer.replaceTextRange(
                                [lastStatement.range[1], closingBrace.range[0]],
                                `\n${indentation}`,
                            ),
                        });
                    }
                }

                return {
                    ArrowFunctionExpression: check,
                    FunctionDeclaration: check,
                    FunctionExpression: check,
                };
            },
        },
        'control-block-layout': {
            meta: {
                type: 'layout',
                fixable: 'whitespace',
                schema: [],
            },
            create(context) {

                const source = context.sourceCode;

                function checkBody(body) {

                    if (body.type !== 'BlockStatement') {
                        context.report({
                            node: body,
                            message: 'Control statement contents must use braces and separate lines.',
                            fix: (fixer) => fixer.replaceText(body, `{\n${source.getText(body)}\n}`),
                        });

                        return;
                    }

                    if (body.body.length === 0) {
                        return;
                    }

                    const openingBrace = source.getFirstToken(body);
                    const closingBrace = source.getLastToken(body);
                    const firstStatement = body.body[0];
                    const lastStatement = body.body.at(-1);

                    if (openingBrace.loc.end.line === firstStatement.loc.start.line) {
                        context.report({
                            node: firstStatement,
                            message: 'Move control statement contents after the opening brace.',
                            fix: (fixer) => fixer.insertTextAfter(openingBrace, '\n'),
                        });
                    }

                    if (lastStatement.loc.end.line === closingBrace.loc.start.line) {
                        context.report({
                            node: lastStatement,
                            message: 'Move the closing brace after the control statement contents.',
                            fix: (fixer) => fixer.insertTextBefore(closingBrace, '\n'),
                        });
                    }
                }

                return {
                    DoWhileStatement: (node) => checkBody(node.body),
                    ForInStatement: (node) => checkBody(node.body),
                    ForOfStatement: (node) => checkBody(node.body),
                    ForStatement: (node) => checkBody(node.body),
                    IfStatement(node) {

                        checkBody(node.consequent);

                        if (node.alternate && node.alternate.type !== 'IfStatement') {
                            checkBody(node.alternate);
                        }
                    },
                    WhileStatement: (node) => checkBody(node.body),
                    WithStatement: (node) => checkBody(node.body),
                };
            },
        },
        'declaration-group-spacing': {
            meta: {
                type: 'layout',
                fixable: 'whitespace',
                schema: [],
            },
            create(context) {

                const source = context.sourceCode;

                function indentation(node) {

                    const text = source.text.slice(0, node.range[0]);

                    return text.slice(text.lastIndexOf('\n') + 1);
                }

                function hasCommentBetween(left, right) {

                    return source.getAllComments().some((comment) => (
                        comment.range[0] >= left.range[1]
                        && comment.range[1] <= right.range[0]
                    ));
                }

                function checkStatements(statements) {

                    for (let index = 1; index < statements.length; index++) {
                        const previous = statements[index - 1];
                        const current = statements[index];

                        if (hasCommentBetween(previous, current)) {
                            continue;
                        }

                        const previousDeclaration = previous.type === 'VariableDeclaration';
                        const currentDeclaration = current.type === 'VariableDeclaration';
                        const lineGap = current.loc.start.line - previous.loc.end.line;

                        if (previousDeclaration && currentDeclaration && lineGap > 1) {
                            context.report({
                                node: current,
                                message: 'Keep declarations in the same group together.',
                                fix: (fixer) => fixer.replaceTextRange(
                                    [previous.range[1], current.range[0]],
                                    `\n${indentation(current)}`,
                                ),
                            });
                        } else if (previousDeclaration !== currentDeclaration && lineGap < 2) {
                            context.report({
                                node: current,
                                message: 'Add an empty line around a declaration group.',
                                fix: (fixer) => fixer.insertTextBefore(current, '\n'),
                            });
                        }
                    }
                }

                return {
                    BlockStatement: (node) => checkStatements(node.body),
                    Program: (node) => checkStatements(node.body),
                };
            },
        },
        'no-hex-numeric-separators': {
            meta: {
                type: 'layout',
                fixable: 'code',
                schema: [],
            },
            create(context) {

                const source = context.sourceCode;

                return {
                    Literal(node) {

                        const raw = source.getText(node);

                        if (/^0[xX][0-9a-fA-F_]+n?$/.test(raw) && raw.includes('_')) {
                            context.report({
                                node,
                                message: 'Hexadecimal literals must not contain numeric separators.',
                                fix: (fixer) => fixer.replaceText(node, raw.replaceAll('_', '')),
                            });
                        }
                    },
                };
            },
        },
    },
};
const styleRules = {
    '@stylistic/array-bracket-newline': ['error', 'consistent'],
    '@stylistic/array-bracket-spacing': ['error', 'never'],
    '@stylistic/arrow-parens': ['error', 'always'],
    '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
    '@stylistic/comma-dangle': ['error', 'always-multiline'],
    '@stylistic/comma-spacing': ['error', { before: false, after: true }],
    '@stylistic/computed-property-spacing': ['error', 'never'],
    '@stylistic/eol-last': ['error', 'always'],
    '@stylistic/function-call-argument-newline': ['error', 'consistent'],
    '@stylistic/function-call-spacing': ['error', 'never'],
    '@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
    '@stylistic/implicit-arrow-linebreak': ['error', 'beside'],
    '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
    '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
    '@stylistic/keyword-spacing': ['error', { before: true, after: true }],
    '@stylistic/linebreak-style': ['error', 'unix'],
    '@stylistic/member-delimiter-style': 'error',
    '@stylistic/multiline-ternary': ['error', 'always-multiline'],
    '@stylistic/new-parens': 'error',
    '@stylistic/no-extra-semi': 'error',
    '@stylistic/no-floating-decimal': 'error',
    '@stylistic/no-mixed-spaces-and-tabs': 'error',
    '@stylistic/no-multi-spaces': 'error',
    '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
    '@stylistic/no-tabs': 'error',
    '@stylistic/no-trailing-spaces': 'error',
    '@stylistic/object-curly-spacing': ['error', 'always'],
    '@stylistic/operator-linebreak': ['error', 'before'],
    '@stylistic/quote-props': ['error', 'as-needed'],
    '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
    '@stylistic/rest-spread-spacing': ['error', 'never'],
    '@stylistic/semi': ['error', 'always'],
    '@stylistic/space-before-blocks': 'error',
    '@stylistic/space-before-function-paren': ['error', { anonymous: 'never', named: 'never', asyncArrow: 'always' }],
    '@stylistic/space-in-parens': ['error', 'never'],
    '@stylistic/space-infix-ops': 'error',
    '@stylistic/space-unary-ops': 'error',
    '@stylistic/spaced-comment': ['error', 'always'],
    '@stylistic/template-curly-spacing': ['error', 'never'],
    '@stylistic/type-annotation-spacing': 'error',
    'local/control-block-layout': 'error',
    'local/declaration-group-spacing': 'error',
    'local/function-body-padding': 'error',
    'local/no-hex-numeric-separators': 'error',
};

export default tseslint.config(
    {
        ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'test-roms/**'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts}'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@stylistic': stylistic,
            local: localRules,
        },
        rules: {
            ...styleRules,
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            'no-console': 'off',
        },
    },
);
