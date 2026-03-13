# Custom Adapter Example

Create your own mmBridge adapter for any AI model:

```bash
# Scaffold a new adapter
npx @mmbridge/create-adapter deepseek

# Edit the implementation
cd mmbridge-adapter-deepseek
# Edit src/index.ts with your model's CLI invocation

# Build and test
npm install
npm run build
npm test
```

## Configuration

Add to `.mmbridge.config.json`:

```json
{
  "adapters": ["mmbridge-adapter-deepseek"]
}
```

Then run:

```bash
mmbridge review --tool deepseek
```
