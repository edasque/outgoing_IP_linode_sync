const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

class IPMonitor {
  constructor(config) {
    this.config = {
      pushover: {
        userKey: config.pushover?.userKey || process.env.PUSHOVER_USER_KEY,
        token: config.pushover?.token || process.env.PUSHOVER_TOKEN || 'your_pushover_app_token'
      },
      linode: {
        apiToken: config.linode?.apiToken || process.env.LINODE_API_TOKEN,
        domainName: config.linode?.domainName || process.env.DOMAIN_NAME || 'example.com'
      },
      database: {
        path: config.database?.path || process.env.DATABASE_PATH || path.join(__dirname, 'ip_history.db')
      },
      schedule: config.schedule || '12 8,16 * * *', // 8:12 AM and 4:00 PM daily
      ipCheckUrl: config.ipCheckUrl || 'https://checkip.amazonaws.com/',
      ...config
    };
    
    this.db = null;
    this.dbRetryAttempts = 0;
    this.maxRetryAttempts = 3;
    this.retryDelay = 1000; // Start with 1 second
    this.dbConnectionHealthy = false;
    this.init();
  }

  async init() {
    try {
      await this.initDatabase();
      console.log('IP Monitor initialized successfully');
    } catch (error) {
      console.error('Failed to initialize IP Monitor:', error);
      throw error;
    }
  }

  // Database utility methods
  async validateDatabasePath() {
    const dbPath = this.config.database.path;
    const dbDir = path.dirname(dbPath);
    
    try {
      // Check if directory exists, create if not
      if (!fs.existsSync(dbDir)) {
        console.log(`Creating database directory: ${dbDir}`);
        fs.mkdirSync(dbDir, { recursive: true });
      }
      
      // Check directory permissions
      fs.accessSync(dbDir, fs.constants.W_OK);
      
      // Check available disk space (basic check)
      const stats = fs.statSync(dbDir);
      if (stats.size !== undefined && stats.size < 1024 * 1024) { // Less than 1MB
        console.warn('Low disk space detected for database directory');
      }
      
      return true;
    } catch (error) {
      throw new Error(`Database path validation failed: ${error.message}`);
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryOperation(operation, operationName = 'database operation') {
    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          console.log(`${operationName} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error) {
        if (attempt === this.maxRetryAttempts) {
          console.error(`${operationName} failed after ${this.maxRetryAttempts} attempts:`, error.message);
          throw error;
        }
        
        const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetryAttempts}), retrying in ${delay}ms:`, error.message);
        await this.sleep(delay);
      }
    }
  }

  async initDatabase() {
    try {
      // Validate database path first
      await this.validateDatabasePath();
      
      // Initialize database with retry logic
      await this.retryOperation(async () => {
        return new Promise((resolve, reject) => {
          this.db = new sqlite3.Database(this.config.database.path, (err) => {
            if (err) {
              this.dbConnectionHealthy = false;
              reject(new Error(`Database connection failed: ${err.message}`));
              return;
            }
            
            // Create table if it doesn't exist
            this.db.run(`
              CREATE TABLE IF NOT EXISTS ip_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
              )
            `, (err) => {
              if (err) {
                this.dbConnectionHealthy = false;
                reject(new Error(`Table creation failed: ${err.message}`));
              } else {
                this.dbConnectionHealthy = true;
                console.log('Database initialized successfully');
                resolve();
              }
            });
          });
        });
      }, 'Database initialization');
      
    } catch (error) {
      this.dbConnectionHealthy = false;
      console.error('Database initialization failed completely:', error.message);
      throw error;
    }
  }

  async getCurrentIP() {
    try {
      const response = await axios.get(this.config.ipCheckUrl, {
        timeout: 10000,
        responseType: 'text'
      });
      
      // Trim whitespace and newlines (solving the \n issue)
      const ip = response.data.trim();
      console.log(`Current IP: ${ip}`);
      return ip;
    } catch (error) {
      console.error('Failed to get current IP:', error.message);
      throw error;
    }
  }

  async getLastStoredIP() {
    if (!this.dbConnectionHealthy) {
      console.warn('Database not healthy, returning null for last stored IP');
      return null;
    }
    
    try {
      return await this.retryOperation(async () => {
        return new Promise((resolve, reject) => {
          this.db.get(`
            SELECT ip_address, created_at
            FROM ip_history
            ORDER BY created_at DESC
            LIMIT 1
          `, (err, row) => {
            if (err) {
              reject(new Error(`Failed to get last stored IP: ${err.message}`));
            } else {
              resolve(row || null);
            }
          });
        });
      }, 'Get last stored IP');
    } catch (error) {
      console.error('Failed to get last stored IP after retries, continuing without history:', error.message);
      return null; // Graceful degradation - continue without history
    }
  }

  async insertIPRecord(ip) {
    if (!this.dbConnectionHealthy) {
      console.warn('Database not healthy, skipping IP record insertion');
      return null;
    }
    
    try {
      return await this.retryOperation(async () => {
        return new Promise((resolve, reject) => {
          this.db.run(`
            INSERT INTO ip_history (ip_address, created_at)
            VALUES (?, CURRENT_TIMESTAMP)
          `, [ip], function(err) {
            if (err) {
              reject(new Error(`Failed to insert IP record: ${err.message}`));
            } else {
              console.log(`IP record inserted with ID: ${this.lastID}`);
              resolve(this.lastID);
            }
          });
        });
      }, 'Insert IP record');
    } catch (error) {
      console.error('Failed to insert IP record after retries, continuing without database logging:', error.message);
      return null; // Graceful degradation - continue without database logging
    }
  }

  async sendPushoverNotification(message, title = 'IP Monitor') {
    try {
      if (!this.config.pushover.userKey) {
        console.log('Pushover not configured, skipping notification');
        console.log(`Would send: ${message}`);
        return;
      }

      const response = await axios.post('https://api.pushover.net/1/messages.json', {
        token: this.config.pushover.token,
        user: this.config.pushover.userKey,
        message: message,
        title: title
      });

      console.log('Pushover notification sent successfully');
      return response.data;
    } catch (error) {
      console.error('Failed to send Pushover notification:', error.response?.data || error.message);
      throw error;
    }
  }

  async getLinodeDomainInfo() {
    try {
      const response = await axios.get('https://api.linode.com/v4/domains', {
        headers: {
          'Authorization': `Bearer ${this.config.linode.apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      const domain = response.data.data.find(d => d.domain === this.config.linode.domainName);
      if (!domain) {
        throw new Error(`Domain ${this.config.linode.domainName} not found`);
      }

      return domain;
    } catch (error) {
      console.error('Failed to get Linode domain info:', error.response?.data || error.message);
      throw error;
    }
  }

  async getDomainRecords(domainId) {
    try {
      const response = await axios.get(`https://api.linode.com/v4/domains/${domainId}/records`, {
        headers: {
          'Authorization': `Bearer ${this.config.linode.apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      // Find the A record with name "*" (wildcard)
      const aRecord = response.data.data.find(record => 
        record.type === 'A' && record.name === '*'
      );

      if (!aRecord) {
        throw new Error('Wildcard A record not found');
      }

      return aRecord;
    } catch (error) {
      console.error('Failed to get domain records:', error.response?.data || error.message);
      throw error;
    }
  }

  async updateDNSRecord(domainId, recordId, newIP) {
    try {
      const response = await axios.put(
        `https://api.linode.com/v4/domains/${domainId}/records/${recordId}`,
        { target: newIP },
        {
          headers: {
            'Authorization': `Bearer ${this.config.linode.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`DNS record updated successfully to ${newIP}`);
      return response.data;
    } catch (error) {
      console.error('Failed to update DNS record:', error.response?.data || error.message);
      throw error;
    }
  }

  async processIPCheck() {
    try {
      console.log('\n--- Starting IP check ---');
      
      // Perform database health check
      await this.checkDatabaseHealth();
      if (!this.dbConnectionHealthy) {
        console.warn('Database health check failed, continuing with limited functionality');
      }
      
      // Get current IP
      const currentIP = await this.getCurrentIP();
      
      // Get last stored IP (gracefully handles DB failure)
      const lastRecord = await this.getLastStoredIP();
      const lastIP = lastRecord?.ip_address || 'no_previous_ip';
      
      console.log(`Current IP: ${currentIP}`);
      console.log(`Last stored IP: ${lastIP} ${!this.dbConnectionHealthy ? '(database unavailable)' : ''}`);
      
      // Check if IP has changed
      if (currentIP !== lastIP) {
        console.log('🌐 IP address has changed!');
        
        // Insert new IP record (gracefully handles DB failure)
        const insertResult = await this.insertIPRecord(currentIP);
        if (!insertResult && this.dbConnectionHealthy) {
          console.warn('Failed to log IP change to database, but continuing...');
        }
        
        // Send notification about change
        const dbStatus = this.dbConnectionHealthy ? '' : ' (Database logging unavailable)';
        const changeMessage = `🌐 IP Address Changed!\n\nNew IP: ${currentIP}\nPrevious IP: ${lastIP}\nTime: ${new Date().toISOString()}${dbStatus}`;
        await this.sendPushoverNotification(changeMessage);
        
        // Update DNS records if Linode is configured
        if (this.config.linode.apiToken) {
          try {
            const domainInfo = await this.getLinodeDomainInfo();
            const aRecord = await this.getDomainRecords(domainInfo.id);
            await this.updateDNSRecord(domainInfo.id, aRecord.id, currentIP);
            
            console.log('DNS record updated successfully');
          } catch (dnsError) {
            console.error('Failed to update DNS record:', dnsError.message);
            await this.sendPushoverNotification(
              `IP changed to ${currentIP} but DNS update failed: ${dnsError.message}`
            );
          }
        } else {
          console.log('Linode API not configured, skipping DNS update');
        }
      } else {
        console.log('IP address has not changed');
        const statusMessage = this.dbConnectionHealthy ? 
          'The IP address has stayed the same on Naples' : 
          'The IP address has stayed the same on Naples (Database logging unavailable)';
        await this.sendPushoverNotification(statusMessage);
      }
      
      console.log('--- IP check completed ---\n');
    } catch (error) {
      console.error('Error during IP check:', error.message);
      await this.sendPushoverNotification(`IP Monitor Error: ${error.message}`);
    }
  }

  start() {
    console.log(`Starting IP Monitor with schedule: ${this.config.schedule}`);
    
    // Run immediately on start (optional)
    if (this.config.runOnStart) {
      console.log('Running initial IP check...');
      setTimeout(() => this.processIPCheck(), 1000);
    }
    
    // Schedule regular checks
    cron.schedule(this.config.schedule, () => {
      this.processIPCheck();
    }, {
      scheduled: true,
      timezone: this.config.timezone || 'America/New_York'
    });
    
    console.log('IP Monitor started successfully');
  }

  stop() {
    if (this.db) {
      this.db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        } else {
          console.log('Database connection closed');
        }
      });
    }
  }

  // Manual trigger for testing
  async checkNow() {
    await this.processIPCheck();
  }

  // Get IP history
  async getIPHistory(limit = 10) {
    if (!this.dbConnectionHealthy) {
      console.warn('Database not healthy, returning empty history');
      return [];
    }
    
    try {
      return await this.retryOperation(async () => {
        return new Promise((resolve, reject) => {
          this.db.all(`
            SELECT ip_address, created_at
            FROM ip_history
            ORDER BY created_at DESC
            LIMIT ?
          `, [limit], (err, rows) => {
            if (err) {
              reject(new Error(`Failed to get IP history: ${err.message}`));
            } else {
              resolve(rows || []);
            }
          });
        });
      }, 'Get IP history');
    } catch (error) {
      console.error('Failed to get IP history after retries:', error.message);
      return []; // Graceful degradation - return empty array
    }
  }
  
  // Database health check
  async checkDatabaseHealth() {
    if (!this.db) {
      this.dbConnectionHealthy = false;
      return false;
    }
    
    try {
      await new Promise((resolve, reject) => {
        this.db.get('SELECT 1', (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        });
      });
      this.dbConnectionHealthy = true;
      return true;
    } catch (error) {
      console.warn('Database health check failed:', error.message);
      this.dbConnectionHealthy = false;
      return false;
    }
  }
}

// Configuration
const config = {
  // Pushover configuration
  pushover: {
    userKey: process.env.PUSHOVER_USER_KEY || 'your_pushover_user_key',
    token: process.env.PUSHOVER_TOKEN || 'your_pushover_app_token'
  },
  
  // Linode API configuration
  linode: {
    apiToken: process.env.LINODE_API_TOKEN || 'your_linode_api_token',
    domainName: 'example.com'
  },
  
  // Database configuration
  database: {
    path: './ip_history.db'
  },
  
  // Cron schedule (8:12 AM and 4:00 PM daily)
  schedule: '12 8,16 * * *',
  
  // Other options
  runOnStart: true, // Run check immediately when starting
  timezone: 'America/New_York'
};

// Create and start the monitor
const monitor = new IPMonitor(config);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  monitor.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  monitor.stop();
  process.exit(0);
});

// Start the monitor
monitor.start();

// Export for programmatic use
module.exports = IPMonitor;

// CLI commands for testing
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'check') {
    console.log('Running manual IP check...');
    monitor.checkNow();
  } else if (command === 'history') {
    monitor.getIPHistory(20).then(history => {
      console.log('\nIP History:');
      console.table(history);
    }).catch(console.error);
  }
}