const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

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

  initDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.config.database.path, (err) => {
        if (err) {
          reject(err);
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
            reject(err);
          } else {
            console.log('Database initialized');
            resolve();
          }
        });
      });
    });
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

  getLastStoredIP() {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT ip_address, created_at
        FROM ip_history
        ORDER BY created_at DESC
        LIMIT 1
      `, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  insertIPRecord(ip) {
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT INTO ip_history (ip_address, created_at)
        VALUES (?, CURRENT_TIMESTAMP)
      `, [ip], function(err) {
        if (err) {
          reject(err);
        } else {
          console.log(`IP record inserted with ID: ${this.lastID}`);
          resolve(this.lastID);
        }
      });
    });
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
      
      // Get current IP
      const currentIP = await this.getCurrentIP();
      
      // Get last stored IP
      const lastRecord = await this.getLastStoredIP();
      const lastIP = lastRecord?.ip_address || 'no_previous_ip';
      
      console.log(`Current IP: ${currentIP}`);
      console.log(`Last stored IP: ${lastIP}`);
      
      // Check if IP has changed
      if (currentIP !== lastIP) {
        console.log('🌐 IP address has changed!');
        
        // Insert new IP record
        await this.insertIPRecord(currentIP);
        
        // Send notification about change
        const changeMessage = `🌐 IP Address Changed!\n\nNew IP: ${currentIP}\nPrevious IP: ${lastIP}\nTime: ${new Date().toISOString()}`;
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
        await this.sendPushoverNotification('The IP address has stayed the same on Naples');
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
  getIPHistory(limit = 10) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT ip_address, created_at
        FROM ip_history
        ORDER BY created_at DESC
        LIMIT ?
      `, [limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
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