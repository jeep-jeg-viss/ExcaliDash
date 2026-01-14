CSRF Protection (8a78b2b)

  - Implemented comprehensive CSRF (Cross-Site Request Forgery) protection for enhanced security
  - Added new backend/src/security.ts module for security utilities
  - Frontend API layer now handles CSRF tokens automatically
  - Added integration tests for CSRF validation

  Upload Progress Indicator (8f9b9b4)

  - Added a visual upload progress bar when users upload files
  - New UploadContext for managing upload state across components
  - New UploadStatus component displaying real-time upload progress
  - Save status indicator when navigating back from the editor
  - Improved error handling and recovery for failed uploads

  Bug Fixes

  - Fixed broken e2e tests (cae8f3c)
  - Replaced deprecated substr() with substring()
  - Fixed stale state issues in error handling
  - Fixed missing useEffect dependencies
  - Fixed CSS class conflicts in progress bar styling
  - Added error recovery for save state in Editor

  Infrastructure

  - Updated docker-compose configurations with new environment variables
  - E2E test suite improvements and reliability fixes
  - Added Kubernetes deployment note in README

### Kubernetes

  A `CSRF_SECRET` environment variable is now required for CSRF protection. Generate a secure 32+ character random string:

  ```bash
  openssl rand -base64 32

  Add it to your deployment:
  - Docker Compose: Add CSRF_SECRET=<your-secret> to the backend service environment
  - Kubernetes: Add to your ConfigMap/Secret and reference in the backend deployment

  If not set, the backend will refuse to start.
  ```
