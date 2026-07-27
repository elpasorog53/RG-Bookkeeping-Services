import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Blob: 'readonly',
        navigator: 'readonly',
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        FormData: 'readonly',
        requestAnimationFrame: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['node_modules/**', 'public/vendor/**'],
  },
];
