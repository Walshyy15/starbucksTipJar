# Starbucks Partner Tips Distribution Tool

A web-based tool for calculating and distributing partner tips fairly. Uses Azure AI Vision API for OCR to read tip sheets.

## Features

- 📸 **OCR Image Processing**: Upload photos of tip sheets and automatically extract partner names, numbers, and hours
- ✏️ **Manual Entry**: Edit extracted data or enter information manually
- 💵 **Automatic Calculations**: Computes hourly tip rate, per-partner tips, and cash payouts
- 🏦 **Bill Breakdown**: Shows exactly how many $20, $10, $5, and $1 bills are needed

## Setup for GitHub Pages Deployment

### 1. Create Azure Computer Vision Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Create a new **Computer Vision** resource (or use existing)
3. Once created, go to the resource and find:
   - **Endpoint**: Under "Keys and Endpoint" (e.g., `https://your-resource.cognitiveservices.azure.com`)
   - **API Key**: Either Key 1 or Key 2

### 2. Configure GitHub Repository Secrets

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Add two new repository secrets:
   - `AZURE_VISION_ENDPOINT`: Your Azure Computer Vision endpoint URL
   - `AZURE_VISION_API_KEY`: Your Azure Computer Vision API key

### 3. Enable GitHub Pages

1. Go to **Settings** → **Pages**
2. Under "Build and deployment":
   - Source: **GitHub Actions**
3. The workflow will automatically deploy when you push to `main` or `master` branch

### 4. Deploy

Push your code to the `main` branch. GitHub Actions will:
1. Inject your Azure credentials into the HTML
2. Deploy to GitHub Pages

Your app will be available at: `https://<your-username>.github.io/<repo-name>/`

## Local Development

For local testing:

1. Copy `index.local.html` and rename to something like `test.html`
2. Edit the `AZURE_CONFIG` object with your real credentials:
   ```javascript
   window.AZURE_CONFIG = {
       endpoint: 'https://your-resource.cognitiveservices.azure.com',
       apiKey: 'your-api-key-here'
   };
   ```
3. Open the file in a browser using a local server (due to CORS):
   ```bash
   # Using Python
   python -m http.server 8000
   
   # Or using Node.js
   npx serve .
   ```
4. Navigate to `http://localhost:8000/test.html`

> ⚠️ **Important**: Never commit files with real API keys to version control!

## How It Works

1. **Upload Image**: Take a photo or upload a screenshot of the tip sheet
2. **OCR Processing**: Azure AI Vision extracts text from the image
3. **Parse Data**: The app parses partner names, numbers, and hours
4. **Review & Edit**: Make any corrections to the extracted data
5. **Calculate**: Enter total tips and calculate per-partner payouts
6. **Bill Breakdown**: See exactly what bills to give each partner

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript
- **OCR**: Azure AI Vision (Read API v3.2)
- **Hosting**: GitHub Pages
- **CI/CD**: GitHub Actions

## Security

- Azure API credentials are stored as GitHub repository secrets
- Credentials are injected at build time, not stored in the repository
- Images are sent directly to Azure's secure API endpoint
- No backend server required

## Troubleshooting

### OCR not working?
- Verify your Azure credentials are correct
- Check the browser console for error messages
- Ensure your Azure Computer Vision resource has OCR capabilities enabled

### GitHub Pages not deploying?
- Check the Actions tab for workflow errors
- Verify repository secrets are set correctly
- Make sure GitHub Pages is enabled with "GitHub Actions" as the source

## License

MIT License
