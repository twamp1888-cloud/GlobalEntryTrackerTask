#!/usr/bin/env node
/**
 * Global Entry Appointment Checker for GitHub Actions
 * 
 * This script checks for Global Entry appointments and sends email notifications
 * when appointments before your target date are found.
 */

const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// TTP API Configuration
const TTP_API_BASE = 'https://ttp.cbp.dhs.gov/schedulerapi';

// File to track notified appointments (persists between runs)
const NOTIFIED_FILE = path.join(__dirname, '.notified-appointments.json');

// Load configuration from environment variables
const CONFIG = {
    smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    },
    emailTo: process.env.EMAIL_TO || process.env.SMTP_USER,
    // Format: locationId:targetDate,locationId:targetDate
    // Example: 5140:2025-04-01,5183:2025-04-01
    locations: parseLocations(process.env.LOCATIONS || '')
};

/**
 * Parse locations from environment variable
 * Format: "locationId:name:targetDate,locationId:name:targetDate"
 * Example: "5140:JFK Terminal 4:2025-04-01,5183:Newark:2025-04-01"
 */
function parseLocations(locationsString) {
    if (!locationsString) {
        console.error('ERROR: LOCATIONS environment variable not set');
        console.log('Format: "locationId:name:targetDate,locationId:name:targetDate"');
        console.log('Example: "5140:JFK Terminal 4:2025-04-01,5183:Newark:2025-04-01"');
        return [];
    }

    return locationsString.split(',').map(loc => {
        const parts = loc.trim().split(':');
        if (parts.length !== 3) {
            console.error(`Invalid location format: ${loc}`);
            return null;
        }
        return {
            id: parts[0],
            name: parts[1],
            targetDate: parts[2]
        };
    }).filter(Boolean);
}

/**
 * Load previously notified appointments from file
 */
function loadNotifiedAppointments() {
    try {
        if (fs.existsSync(NOTIFIED_FILE)) {
            const data = fs.readFileSync(NOTIFIED_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (error) {
        console.log('No previous notifications file found (first run)');
    }
    return new Set();
}

/**
 * Save notified appointments to file
 */
function saveNotifiedAppointments(notified) {
    try {
        fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([...notified]), 'utf8');
    } catch (error) {
        console.error('Error saving notifications:', error.message);
    }
}

/**
 * Create email transporter
 */
function createEmailTransporter() {
    if (!CONFIG.smtp.auth.user || !CONFIG.smtp.auth.pass) {
        throw new Error('Email credentials not configured. Set SMTP_USER and SMTP_PASS environment variables.');
    }
    return nodemailer.createTransport(CONFIG.smtp);
}

/**
 * Send email notification
 */
async function sendEmail(subject, text) {
    const transporter = createEmailTransporter();
    
    try {
        await transporter.sendMail({
            from: CONFIG.smtp.auth.user,
            to: CONFIG.emailTo,
            subject: subject,
            text: text,
            html: text.replace(/\n/g, '<br>')
        });
        console.log(`✓ Email sent: ${subject}`);
        return true;
    } catch (error) {
        console.error(`✗ Error sending email: ${error.message}`);
        return false;
    }
}

/**
 * Check appointments for a specific location
 */
async function checkLocation(locationId) {
    try {
        const response = await axios.get(`${TTP_API_BASE}/slots`, {
            params: {
                orderBy: 'soonest',
                limit: 5,
                locationId: locationId,
                minimum: 1
            },
            timeout: 10000
        });
        
        return response.data || [];
    } catch (error) {
        console.error(`Error checking location ${locationId}: ${error.message}`);
        return [];
    }
}

/**
 * Format date for display
 */
function formatDate(isoDate) {
    const date = new Date(isoDate);
    return date.toLocaleDateString('en-US', { 
        weekday: 'long',
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Main checking logic
 */
async function checkAllLocations() {
    console.log('='.repeat(60));
    console.log('Global Entry Appointment Checker');
    console.log('='.repeat(60));
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Checking ${CONFIG.locations.length} location(s)...`);
    console.log('');

    if (CONFIG.locations.length === 0) {
        console.error('No locations configured!');
        console.log('Set the LOCATIONS environment variable in GitHub Secrets.');
        process.exit(1);
    }

    // Load previously notified appointments
    const notified = loadNotifiedAppointments();
    let newNotifications = 0;

    // Check each location
    for (const location of CONFIG.locations) {
        console.log(`Checking: ${location.name} (ID: ${location.id})`);
        console.log(`  Target date: ${location.targetDate}`);

        const slots = await checkLocation(location.id);

        if (slots.length === 0) {
            console.log(`  ✗ No appointments available`);
            console.log('');
            continue;
        }

        console.log(`  ✓ Found ${slots.length} appointment(s)`);

        // Check each slot
        for (const slot of slots) {
            const appointmentDate = slot.startTimestamp.split('T')[0];
            const appointmentKey = `${location.id}_${slot.startTimestamp}`;

            console.log(`    - ${formatDate(slot.startTimestamp)}`);

            // Check if this is before target date and we haven't notified yet
            if (appointmentDate < location.targetDate) {
                if (!notified.has(appointmentKey)) {
                    console.log(`    🎉 BETTER APPOINTMENT FOUND!`);

                    // Send notification
                    const subject = `🎉 Global Entry: Appointment Before ${location.targetDate}!`;
                    const message = `
Great news! A Global Entry appointment is available before your target date.

📍 Location: ${location.name}
🆔 Location ID: ${location.id}
📅 Appointment: ${formatDate(slot.startTimestamp)}
🎯 Your Target: ${location.targetDate}

🔗 Book now: https://ttp.cbp.dhs.gov/

⏰ Found at: ${new Date().toLocaleString()}

Don't wait - appointments fill up quickly!
                    `.trim();

                    const sent = await sendEmail(subject, message);
                    if (sent) {
                        notified.add(appointmentKey);
                        newNotifications++;
                    }
                }
            }
        }

        console.log('');
        
        // Small delay between locations to be respectful
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Save updated notifications
    saveNotifiedAppointments(notified);

    // Summary
    console.log('='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));
    console.log(`Total locations checked: ${CONFIG.locations.length}`);
    console.log(`New notifications sent: ${newNotifications}`);
    console.log(`Total appointments tracked: ${notified.size}`);
    console.log(`Completed: ${new Date().toISOString()}`);
    console.log('='.repeat(60));
}

// Run the checker
checkAllLocations().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
