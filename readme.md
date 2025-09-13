# IP Address Monitor

A Node.js application that monitors your external IP address, detects changes, sends notifications, and automatically updates DNS records on linode.

## Features

- 🌐 **IP Monitoring**: Regularly checks your external IP address using AWS's checkip service
- 📊 **SQLite Database**: Stores IP address history with timestamps
- 🔔 **Push Notifications**: Sends alerts via Pushover when IP changes
- 🌍 **DNS Updates**: Automatically updates Linode DNS records when IP changes (specifically updates the wildcard A record "*" with your new IP)
- ⏰ **Scheduled Execution**: Runs on a cron schedule (default: 8:12 AM and 4:00 PM daily)
- 🧹 **Clean IP Processing**: Properly trims newlines and whitespace from IP addresses
- 🔧 **Manual Triggers**: Support for manual IP checks and history viewing

## Installation

1. **Clone or create the project:**
   ```bash
   mkdir outgoing_IP_linode_sync
   cd outgoing_IP_linode_sync
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   # Copy and edit the environment file
   cp .env.example .env
   ```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# Pushover Configuration (Required for notifications)
PUSHOVER_USER_KEY=your_pushover_user_key_here
PUSHOVER_TOKEN=your_pushover_app_token_here

# Linode API Configuration (Required for DNS updates)
LINODE_API_TOKEN=your_linode_api_token_here

# Optional: Database path (defaults to ./ip_history.db)
# DATABASE_PATH=./ip_history.db
```

### Getting API Keys

#### Pushover Setup:
1. Sign up at [pushover.net](https://pushover.net/)
2. Create a new application to get your **App Token**
3. Your **User Key** is available on your dashboard
4. Install the Pushover app on your phone/device

#### Linode API Setup:
1. Log into your [Linode Cloud Manager](https://cloud.linode.com/)
2. Go to **Profile** → **API Tokens**
3. Click **Create a Personal Access Token**
4. Give it **Read/Write** permissions for **Domains**
5. Copy the generated token

## Usage

### Start the Monitor

```bash
# Start with default schedule (8:12 AM and 4:00 PM daily)
npm start
```

### Manual Commands

```bash
# Run a manual IP check
npm run check

# View IP address history
npm run history

# Development mode with auto-restart
npm run dev
```

### Programmatic Usage

```javascript
const IPMonitor = require('./ip_monitor_app.js');

const monitor = new IPMonitor({
  pushover: {
    userKey: 'your_user_key',
    token: 'your_app_token'
  },
  linode: {
    apiToken: 'your_linode_token',
    domainName: 'yourdomain.com'
  },
  schedule: '0 */6 * * *', // Every 6 hours
  runOnStart: true
});

monitor.start();

// Manual check
monitor.checkNow();

// Get history
monitor.getIPHistory(10).then(console.log);
```

## Configuration Options

```javascript
const config = {
  // Pushover notifications
  pushover: {
    userKey: 'your_pushover_user_key',
    token: 'your_pushover_app_token'
  },
  
  // Linode DNS management
  linode: {
    apiToken: 'your_linode_api_token',
    domainName: 'your-domain.com'
  },
  
  // Database settings
  database: {
    path: './ip_history.db'
  },
  
  // Cron schedule (default: 8:12 AM and 4:00 PM daily)
  schedule: '12 8,16 * * *',
  
  // IP check service URL
  ipCheckUrl: 'https://checkip.amazonaws.com/',
  
  // Other options
  runOnStart: true,          // Run check immediately on startup
  timezone: 'America/New_York'
};
```

## Cron Schedule Format

The schedule uses standard cron format:
```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday)
│ │ │ │ │
* * * * *
```

Examples:
- `'12 8,16 * * *'` - 8:12 AM and 4:00 PM daily (default)
- `'0 */2 * * *'` - Every 2 hours
- `'0 9 * * 1-5'` - 9 AM on weekdays only
- `'30 6 * * *'` - 6:30 AM daily

## Data Persistence

### Database Storage

The application uses SQLite for persistent data storage, automatically creating a database file to track IP address changes over time. This ensures continuity across application restarts and provides historical data for analysis.

**Key persistence features:**
- **Automatic database creation**: Creates `ip_history.db` on first run
- **Graceful restarts**: Maintains IP history across application restarts
- **Change detection**: Only triggers notifications and DNS updates when IP actually changes
- **Historical tracking**: Stores complete history of IP changes with timestamps

### Database Schema

The SQLite database stores IP history:

```sql
CREATE TABLE ip_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Database Location

By default, the database is stored as `ip_history.db` in the project directory. You can customize this location using the `DATABASE_PATH` environment variable:

```bash
DATABASE_PATH=/path/to/your/custom/location/ip_history.db
```

### Backup Considerations

Since the database contains your IP address history:
- Regular backups are recommended for long-term historical data
- The database file is included in `.gitignore` to prevent accidental commits
- For Docker deployments, use volumes to persist data across container restarts

## Process Manager (Production)

For production deployment, use PM2:

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start ip_monitor_app.js --name "ip-monitor"

# View logs
pm2 logs ip-monitor

# Restart
pm2 restart ip-monitor

# Stop
pm2 stop ip-monitor

# Save PM2 configuration
pm2 save
pm2 startup
```

## Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY ip_monitor_app.js ./

# Create directory for database
RUN mkdir -p /app/data

# Set database path to volume
ENV DATABASE_PATH=/app/data/ip_history.db

# Create volume for database persistence
VOLUME ["/app/data"]

CMD ["node", "ip_monitor_app.js"]
```

Build and run:
```bash
# Build the image
docker build -t ip-monitor .

# Create data directory for persistence
mkdir -p ./data

# Run with volume for database persistence
docker run -d --name ip-monitor --env-file .env -v $(pwd)/data:/app/data ip-monitor
```

### Docker Environment Variables

When running with Docker, the database will automatically be stored in the mounted volume. You can still override this by setting `DATABASE_PATH` in your `.env` file:

```bash
# In your .env file, to use a custom path within the container
DATABASE_PATH=/app/data/custom_ip_history.db
```

## Troubleshooting

### Common Issues

1. **Database locked error:**
   - Make sure only one instance is running
   - Check file permissions for the database path

2. **Pushover notifications not working:**
   - Verify your User Key and App Token
   - Check that the Pushover app is installed on your device

3. **DNS updates failing:**
   - Verify your Linode API token has domain permissions
   - Check that the domain name is correct
   - Ensure the wildcard A record (*) exists - this is the record that gets updated with your new IP address

4. **IP detection issues:**
   - The app automatically trims newlines/whitespace from the IP
   - If AWS service is down, you can change `ipCheckUrl` in config

### Debug Mode

Add debug logging by setting the `DEBUG` environment variable:

```bash
DEBUG=* npm start
```


## License

MIT License - feel free to modify and use as needed.

## Development & Contributing

### Known Issues

#### Minor Issues:
- **No actual testing**: Currently has placeholder test script only
- **Missing node_modules**: Dependencies need to be installed with `npm install`

### Planned Improvements

#### 🔧 Medium Priority (Medium Impact, Low-Medium Difficulty):
1. **Add error handling improvements** - Better user experience for network failures
2. **Add config validation** - Prevent runtime errors from invalid configuration
3. **Improve logging levels** - Configurable debug/info/warn/error levels
4. **Add health check endpoint** - HTTP endpoint for monitoring systems

#### 🚀 High Impact Features (Higher Difficulty):
1. **Add unit tests** - Comprehensive test coverage for reliability
2. **Add multiple IP services** - Fallback services if AWS checkip fails
3. **Add webhook notifications** - Slack/Discord/Teams notification support
4. **Add web dashboard** - Visual monitoring interface with charts
5. **Add multiple domain support** - Manage DNS records for multiple domains
6. **Add retry logic with exponential backoff** - Improve reliability for API failures
7. **Add metrics/prometheus support** - Export metrics for observability platforms

#### 🔬 Nice to Have:
1. **Add TypeScript** - Better development experience with type safety
2. **Add CI/CD pipeline** - Automated testing and deployment
3. **Add Docker compose** - Easier multi-service deployment
4. **Add Kubernetes manifests** - Production K8s deployment templates
5. **Add ARM Docker images** - Support for Raspberry Pi and ARM-based systems

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request