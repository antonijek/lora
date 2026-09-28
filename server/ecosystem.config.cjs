module.exports = {
  apps: [
    {
      name: 'lora-server',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        PORT: 3002,
      },
    },
  ],
};
