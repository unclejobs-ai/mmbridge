# Basic Review Example

Run a multi-model code review on your project:

```bash
# Install mmbridge globally
npm install -g @mmbridge/cli

# Check environment
mmbridge doctor

# Run review with all models
mmbridge review --tool all --mode uncommitted

# Run single model
mmbridge review --tool codex --mode base

# Open dashboard
mmbridge dashboard
```
