require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

// ==================== VARIABILE GLOBALE PER IL CLIENT ====================
let botInstance = null;

// ==================== VALIDAZIONE ENV ====================
const TOKEN = process.env.DISCORD_TOKEN?.trim() || process.env.TOKEN?.trim();
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID?.trim();
const CLIENT_ID = process.env.CLIENT_ID?.trim();

if (!TOKEN) throw new Error('TOKEN mancante nel file .env');
if (!MOD_LOG_CHANNEL_ID) throw new Error('MOD_LOG_CHANNEL_ID mancante nel file .env');
if (!CLIENT_ID) throw new Error('CLIENT_ID mancante nel file .env');

// ==================== UTILITY FUNCTIONS ====================

function formatDate(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleString('it-IT');
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}g`;
}

function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function getRoles(member, guild) {
  if (!member) return 'N/A';
  return member.roles.cache
    .filter(r => r.id !== guild.id)
    .map(r => r.toString())
    .join(', ') || 'Nessuno';
}

function isValidId(id) {
  return /^\d{17,20}$/.test(id);
}

function extractUserId(input) {
  if (!input) return null;
  
  // Menzione utente: <@123456789> o <@!123456789>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  
  // ID numerico
  if (/^\d{17,20}$/.test(input)) {
    return input;
  }
  
  return null;
}

function isTicketChannel(channel) {
  return channel.name && channel.name.startsWith('ticket-');
}

function calculatePages(totalItems, itemsPerPage) {
  return Math.ceil(totalItems / itemsPerPage);
}

function getPaginatedSlice(array, page, itemsPerPage) {
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  return array.slice(start, end);
}

// Rate limiting
const cooldowns = new Map();

function checkCooldown(userId, commandName, cooldownTime = 3000) {
  const key = `${userId}-${commandName}`;
  const now = Date.now();
  const cooldown = cooldowns.get(key);
  
  if (cooldown && now < cooldown) {
    const remaining = Math.ceil((cooldown - now) / 1000);
    return { onCooldown: true, remaining };
  }
  
  cooldowns.set(key, now + cooldownTime);
  setTimeout(() => cooldowns.delete(key), cooldownTime);
  return { onCooldown: false };
}

// ==================== EMBED MANAGER ====================

class EmbedManager {
  static createEmbed(options = {}) {
    const embed = new EmbedBuilder();
    if (options.title) embed.setTitle(options.title);
    if (options.description) embed.setDescription(options.description);
    if (options.color) embed.setColor(options.color);
    if (options.fields) embed.addFields(...options.fields);
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.image) embed.setImage(options.image);
    if (options.author) embed.setAuthor(options.author);
    if (options.footer) embed.setFooter(options.footer);
    if (options.timestamp) embed.setTimestamp();
    return embed;
  }

  static success(title, description) {
    return this.createEmbed({ title, description, color: 0x00FF00, timestamp: true });
  }

  static error(title, description) {
    return this.createEmbed({ title, description, color: 0xFF0000, timestamp: true });
  }

  static info(title, description) {
    return this.createEmbed({ title, description, color: 0x0099FF, timestamp: true });
  }

  static warning(title, description) {
    return this.createEmbed({ title, description, color: 0xFFA500, timestamp: true });
  }
}

// ==================== STORAGE SERVICE ====================

class StorageService {
  constructor() {
    this.customCommandsFile = './customCommands.json';
    this.modLogFile = './modLog.json';
    this.blacklistFile = './blacklist.json';
    this.initFiles();
  }

  initFiles() {
    if (!fs.existsSync(this.customCommandsFile)) fs.writeFileSync(this.customCommandsFile, '{}');
    if (!fs.existsSync(this.modLogFile)) fs.writeFileSync(this.modLogFile, '[]');
    if (!fs.existsSync(this.blacklistFile)) fs.writeFileSync(this.blacklistFile, '[]');
  }

  loadCommands() {
    try {
      return JSON.parse(fs.readFileSync(this.customCommandsFile));
    } catch {
      return {};
    }
  }

  saveCommands(data) {
    fs.writeFileSync(this.customCommandsFile, JSON.stringify(data, null, 2));
  }

  loadLogs() {
    try {
      return JSON.parse(fs.readFileSync(this.modLogFile));
    } catch {
      return [];
    }
  }

  saveLog(entry) {
    try {
      const logs = this.loadLogs();
      logs.push({ ...entry, timestamp: new Date().toISOString() });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      fs.writeFileSync(this.modLogFile, JSON.stringify(logs, null, 2));
    } catch (err) {
      console.error('Errore salvataggio log:', err);
    }
  }

  loadBlacklist() {
    try {
      return JSON.parse(fs.readFileSync(this.blacklistFile));
    } catch {
      return [];
    }
  }

  saveBlacklist(data) {
    fs.writeFileSync(this.blacklistFile, JSON.stringify(data, null, 2));
  }

  isBlacklisted(userId) {
    return this.loadBlacklist().some(e => e.userId === userId);
  }

  getBlacklistEntry(userId) {
    return this.loadBlacklist().find(e => e.userId === userId) || null;
  }

  addToBlacklist(userId, username, reason, moderatorId, moderatorTag) {
    const list = this.loadBlacklist();
    if (list.some(e => e.userId === userId)) return false;
    list.push({ userId, username, reason, moderatorId, moderatorTag, addedAt: new Date().toISOString() });
    this.saveBlacklist(list);
    return true;
  }

  removeFromBlacklist(userId) {
    const list = this.loadBlacklist();
    const idx = list.findIndex(e => e.userId === userId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.saveBlacklist(list);
    return true;
  }
}

// ==================== MOD LOG MODULE ====================

class ModLogModule {
  constructor(client, modLogChannelId, storage) {
    this.client = client;
    this.modLogChannelId = modLogChannelId;
    this.storage = storage;
  }

  async logUserAction(guild, logData = {}) {
    try {
      const logChannel = guild.channels.cache.get(this.modLogChannelId);
      if (logChannel) {
        const logEmbed = EmbedManager.createEmbed({
          title: logData.title || 'Azione Mod',
          color: 0x5865F2,
          fields: [
            { name: 'Type', value: logData.type || 'N/A', inline: true },
            { name: 'Target', value: logData.target || 'N/A', inline: true },
            logData.moderator ? { name: 'Moderator', value: logData.moderator, inline: true } : null,
            logData.user ? { name: 'User', value: logData.user, inline: true } : null,
            logData.channel ? { name: 'Channel', value: logData.channel, inline: true } : null,
            logData.reason ? { name: 'Reason', value: logData.reason, inline: false } : null,
            logData.duration ? { name: 'Duration', value: logData.duration, inline: true } : null,
            { name: 'Date', value: new Date().toLocaleString('it-IT'), inline: false }
          ].filter(Boolean),
          timestamp: true
        });
        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch (err) {
      console.error('Errore log canale:', err);
    }
    this.storage.saveLog(logData);
  }
}

// ==================== TICKET MODULE ====================

class TicketModule {
  constructor(modLogModule, client) {
    this.modLogModule = modLogModule;
    this.client = client;
    this.closingTickets = new Set();
    this.ticketCooldown = new Map();
  }

  async createTicket(source, user) {
    const guild = source.guild;
    
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Permessi Insufficienti', 'Il bot non ha il permesso di gestire canali.')],
        ephemeral: true
      });
    }

    const lastTicket = this.ticketCooldown.get(user.id);
    if (lastTicket && Date.now() - lastTicket < 300000) {
      const remaining = Math.ceil((300000 - (Date.now() - lastTicket)) / 60000);
      return this.reply(source, {
        embeds: [EmbedManager.error('Cooldown', `Devi attendere ${remaining} minuti prima di aprire un altro ticket.`)],
        ephemeral: true
      });
    }
    
    try {
      const existingTicket = guild.channels.cache.find(c => c.name === `ticket-${user.id}`);
      if (existingTicket) {
        return this.reply(source, {
          embeds: [EmbedManager.error('Ticket Esistente', `Hai già un ticket aperto: ${existingTicket}`)],
          ephemeral: true
        });
      }

      const adminRole = guild.roles.cache.find(r => r.permissions.has(PermissionsBitField.Flags.Administrator));
      const permissionOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
          id: user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks
          ]
        }
      ];

      if (adminRole) {
        permissionOverwrites.push({
          id: adminRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks
          ]
        });
      }

      const channel = await guild.channels.create({
        name: `ticket-${user.id}`,
        type: ChannelType.GuildText,
        permissionOverwrites
      });

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Chiudi Ticket')
        .setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(closeButton);

      const ticketEmbed = EmbedManager.createEmbed({
        title: 'Ticket Aperto',
        description: `Benvenuto ${user}, questo è il tuo ticket.\n\nDescrivi il tuo problema e un membro dello staff ti assisterà.`,
        color: 0x0099FF,
        fields: [
          { name: 'Utente', value: `${user.username} (${user.id})`, inline: true },
          { name: 'Canale', value: `${channel}`, inline: true }
        ],
        timestamp: true
      });

      await channel.send({ embeds: [ticketEmbed], components: [row] });
      await this.reply(source, {
        embeds: [EmbedManager.success('Ticket Creato', `Ticket creato: ${channel}`)],
        ephemeral: true
      });

      await this.modLogModule.logUserAction(guild, {
        type: 'Ticket Aperto',
        title: 'Ticket Aperto',
        user: `${user.username} (${user.id})`,
        channel: channel.name
      });

      this.ticketCooldown.set(user.id, Date.now());

    } catch (err) {
      console.error('Errore creazione ticket:', err);
      await this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Errore nella creazione del ticket.')],
        ephemeral: true
      });
    }
  }

  async closeTicket(source, user) {
    const channel = source.channel;
    
    if (!isTicketChannel(channel)) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Questo comando può essere usato solo nei ticket.')],
        ephemeral: true
      });
    }

    const ticketUserId = channel.name.replace('ticket-', '');
    const isOwner = user.id === ticketUserId;
    const isAdmin = source.member?.permissions.has(PermissionsBitField.Flags.Administrator);
    
    if (!isOwner && !isAdmin) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Accesso Negato', 'Solo l\'autore del ticket o un admin possono chiuderlo.')],
        ephemeral: true
      });
    }

    if (this.closingTickets.has(channel.id)) return;
    this.closingTickets.add(channel.id);

    try {
      await this.reply(source, {
        embeds: [EmbedManager.createEmbed({
          title: 'Ticket in Chiusura',
          description: 'Il ticket verrà chiuso tra 3 secondi...',
          color: 0xFF0000,
          timestamp: true
        })],
        ephemeral: true
      });

      await this.modLogModule.logUserAction(channel.guild, {
        type: 'Ticket Chiuso',
        title: 'Ticket Chiuso',
        user: `${user.username} (${user.id})`,
        channel: channel.name
      });

      setTimeout(async () => {
        try {
          const stillExists = channel.guild.channels.cache.get(channel.id);
          if (stillExists && channel.deletable) {
            await channel.delete();
          }
        } catch (err) {
          console.error('Errore eliminazione canale:', err);
        } finally {
          this.closingTickets.delete(channel.id);
        }
      }, 3000);

    } catch (err) {
      console.error('Errore chiusura ticket:', err);
      this.closingTickets.delete(channel.id);
    }
  }

  async reply(source, data) {
    if (source.replied || source.deferred) {
      return source.followUp(data);
    }
    return source.reply(data);
  }
}

// ==================== LOBBY MODULE ====================

class LobbyModule {
  constructor(client) {
    this.client = client;
  }

  async createLobby(interaction) {
    const user = interaction.user;
    const guild = interaction.guild;

    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({
        embeds: [EmbedManager.error('Permessi Insufficienti', 'Il bot non ha il permesso di gestire canali.')],
        ephemeral: true
      });
    }

    const existing = guild.channels.cache.find(
      c => c.name === `lobby-${user.username}` && c.type === ChannelType.GuildCategory
    );

    if (existing) {
      return interaction.reply({
        embeds: [EmbedManager.error('Lobby Esistente', 'Hai già una lobby attiva!')],
        ephemeral: true
      });
    }

    try {
      const category = await guild.channels.create({
        name: `lobby-${user.username}`,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.Speak
            ]
          }
        ]
      });

      const text = await guild.channels.create({
        name: `chat-${user.username}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: category.permissionOverwrites.cache
      });

      const voice = await guild.channels.create({
        name: `lobby-${user.username}`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: category.permissionOverwrites.cache
      });

      const embed = EmbedManager.success('Lobby Creata!', `La tua lobby privata è pronta, ${user}!`)
        .addFields(
          { name: 'Categoria', value: category.name, inline: true },
          { name: 'Testuale', value: `${text}`, inline: true },
          { name: 'Vocale', value: `${voice}`, inline: true }
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });

    } catch (err) {
      console.error('Errore creazione lobby:', err);
      return interaction.reply({
        embeds: [EmbedManager.error('Errore', 'Errore nella creazione della lobby.')],
        ephemeral: true
      });
    }
  }
}

// ==================== MOD LOGS MODULE ====================

class ModLogsModule {
  constructor(storage) {
    this.storage = storage;
  }

  async handleModlogs(source, target, isSlash) {
    if (!target) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Utente non valido.')],
        ephemeral: isSlash
      }, isSlash);
    }

    const logs = this.storage.loadLogs();

    if (!logs.length) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Nessun log trovato.')],
        ephemeral: isSlash
      }, isSlash);
    }

    const userLogs = logs.filter(l =>
      l.targetId === target.id &&
      ['Warn', 'Timeout', 'Ban', 'Unban', 'Mute', 'Unmute', 'Ticket Aperto', 'Ticket Chiuso'].includes(l.type)
    );

    if (userLogs.length === 0) {
      return this.reply(source, {
        embeds: [EmbedManager.createEmbed({
          title: 'Nessun Log',
          description: `Nessun log trovato per **${target.username}**.`,
          color: 0x808080,
          timestamp: true
        })],
        ephemeral: isSlash
      }, isSlash);
    }

    const ITEMS_PER_PAGE = 5;
    const totalPages = calculatePages(userLogs.length, ITEMS_PER_PAGE);
    let page = 0;

    const buildEmbed = (p) => {
      const slice = getPaginatedSlice(userLogs, p, ITEMS_PER_PAGE);
      const fields = slice.map((l, i) => {
        const caseNum = userLogs.length - (p * ITEMS_PER_PAGE + i);
        return {
          name: `Case ${caseNum} - ${l.type}`,
          value: [
            l.moderator ? `**Moderatore:** ${l.moderator}` : null,
            l.reason ? `**Motivo:** ${l.reason}` : null,
            l.duration ? `**Durata:** ${l.duration}` : null,
            `**Data:** ${formatDate(l.timestamp)}`
          ].filter(Boolean).join('\n'),
          inline: false
        };
      });

      return EmbedManager.createEmbed({
        title: `Modlogs - ${target.username}`,
        color: 0x5865F2,
        fields: fields.length > 0 ? fields : [{ name: 'Nessun Log', value: 'Nessuna azione trovata', inline: false }],
        footer: { text: `Pagina ${p + 1}/${totalPages} | Log totali: ${userLogs.length}` },
        timestamp: true
      });
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('modlogs_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('modlogs_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1)
    );

    let msg;
    if (isSlash) {
      await source.reply({ embeds: [buildEmbed(0)], components: totalPages > 1 ? [row] : [], ephemeral: false });
      msg = await source.fetchReply();
    } else {
      msg = await source.channel.send({ embeds: [buildEmbed(0)], components: totalPages > 1 ? [row] : [] });
    }

    if (totalPages <= 1) return;

    const authorId = isSlash ? source.user.id : source.author.id;
    const collector = msg.createMessageComponentCollector({ time: 60000 });

    collector.on('collect', async btn => {
      if (btn.user.id !== authorId) {
        return btn.reply({ embeds: [EmbedManager.error('Non Autorizzato', 'Non puoi usare questi bottoni.')], ephemeral: true });
      }
      if (btn.customId === 'modlogs_prev') page = Math.max(0, page - 1);
      if (btn.customId === 'modlogs_next') page = Math.min(totalPages - 1, page + 1);

      const updatedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('modlogs_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('modlogs_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
      );
      await btn.update({ embeds: [buildEmbed(page)], components: [updatedRow] });
    });

    collector.on('end', async () => { 
      try { 
        await msg.edit({ components: [] }); 
      } catch { 
        // Ignora errori di edit
      } 
    });
  }

  async reply(source, data, isSlash) {
    if (isSlash) {
      if (source.replied || source.deferred) {
        return source.followUp(data);
      }
      return source.reply(data);
    }
    return source.channel.send(data);
  }
}

// ==================== BLACKLIST MODULE ====================

class BlacklistModule {
  constructor(storage, modLogModule, client) {
    this.storage = storage;
    this.modLogModule = modLogModule;
    this.client = client;
  }

  async handleGuildMemberAdd(member) {
    if (!this.storage.isBlacklisted(member.user.id)) return;
    const entry = this.storage.getBlacklistEntry(member.user.id);
    try {
      await member.send({
        embeds: [EmbedManager.error('Accesso Negato', `Sei nella blacklist globale.\n**Motivo:** ${entry.reason}`)]
      }).catch(() => {});
      await member.kick(`[BLACKLIST GLOBALE] ${entry.reason}`);
      await this.modLogModule.logUserAction(member.guild, {
        type: 'Blacklist Kick',
        title: 'Blacklist Kick Automatico',
        target: `${member.user.username} (${member.user.id})`,
        reason: entry.reason,
        moderator: 'Sistema Automatico'
      });
    } catch (err) {
      console.error(`Errore kick blacklist su ${member.guild.name}:`, err);
    }
  }

  async addBlacklist(source, targetUser, reason, moderator, isSlash) {
    if (!reason) reason = 'Nessun motivo specificato';

    if (this.storage.isBlacklisted(targetUser.id)) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Già in Blacklist', `${targetUser.username} è già nella blacklist globale.`)],
        ephemeral: isSlash
      }, isSlash);
    }
    if (targetUser.id === this.client.user.id) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Non puoi mettere in blacklist il bot.')],
        ephemeral: isSlash
      }, isSlash);
    }
    if (targetUser.id === moderator.id) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Non puoi mettere te stesso in blacklist.')],
        ephemeral: isSlash
      }, isSlash);
    }

    this.storage.addToBlacklist(targetUser.id, targetUser.username, reason, moderator.id, moderator.tag ?? moderator.username);

    try {
      await targetUser.send({
        embeds: [EmbedManager.error('Aggiunto alla Blacklist Globale', `Sei stato aggiunto alla blacklist globale.\n**Motivo:** ${reason}`)]
      });
    } catch (err) {
      // Ignora errore DM
    }

    const banPromises = this.client.guilds.cache.map(async (guild) => {
      try {
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        if (member) {
          await guild.members.ban(targetUser.id, { reason: `[BLACKLIST GLOBALE] ${reason}` });
          await this.modLogModule.logUserAction(guild, {
            type: 'Blacklist Ban',
            title: 'Ban Globale (Blacklist)',
            targetId: targetUser.id,
            target: `${targetUser.username} (${targetUser.id})`,
            moderator: `${moderator.username} (${moderator.id})`,
            reason
          });
          return true;
        }
      } catch (err) {
        console.error(`Errore ban blacklist su ${guild.name}:`, err);
      }
      return false;
    });

    const results = await Promise.allSettled(banPromises);
    const bannedCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    return this.reply(source, {
      embeds: [EmbedManager.createEmbed({
        title: 'Blacklist Globale Aggiunta',
        color: 0x8B0000,
        fields: [
          { name: 'Utente', value: `${targetUser.username} (${targetUser.id})`, inline: true },
          { name: 'Moderatore', value: `${moderator.username}`, inline: true },
          { name: 'Server Bannati', value: `${bannedCount}`, inline: true },
          { name: 'Motivo', value: reason, inline: false }
        ],
        timestamp: true
      })],
      ephemeral: false
    }, isSlash);
  }

  async removeBlacklist(source, targetUser, moderator, isSlash) {
    if (!this.storage.isBlacklisted(targetUser.id)) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Non in Blacklist', `${targetUser.username} non è nella blacklist globale.`)],
        ephemeral: isSlash
      }, isSlash);
    }

    this.storage.removeFromBlacklist(targetUser.id);

    const unbanPromises = this.client.guilds.cache.map(async (guild) => {
      try {
        const bans = await guild.bans.fetch();
        if (bans.has(targetUser.id)) {
          await guild.members.unban(targetUser.id, `[BLACKLIST RIMOSSA] ${moderator.username}`);
          await this.modLogModule.logUserAction(guild, {
            type: 'Blacklist Unban',
            title: 'Unban Globale (Blacklist Rimossa)',
            targetId: targetUser.id,
            target: `${targetUser.username} (${targetUser.id})`,
            moderator: `${moderator.username} (${moderator.id})`,
            reason: 'Blacklist globale rimossa'
          });
          return true;
        }
      } catch (err) {
        console.error(`Errore unban blacklist su ${guild.name}:`, err);
      }
      return false;
    });

    const results = await Promise.allSettled(unbanPromises);
    const unbannedCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    try {
      await targetUser.send({
        embeds: [EmbedManager.success('Rimosso dalla Blacklist Globale', 'Sei stato rimosso dalla blacklist globale.')]
      });
    } catch (err) {
      // Ignora errore DM
    }

    return this.reply(source, {
      embeds: [EmbedManager.createEmbed({
        title: 'Blacklist Globale Rimossa',
        color: 0x00FF00,
        fields: [
          { name: 'Utente', value: `${targetUser.username} (${targetUser.id})`, inline: true },
          { name: 'Moderatore', value: `${moderator.username}`, inline: true },
          { name: 'Server Sbannati', value: `${unbannedCount}`, inline: true }
        ],
        timestamp: true
      })],
      ephemeral: false
    }, isSlash);
  }

  async listBlacklist(source, isSlash) {
    const list = this.storage.loadBlacklist();

    if (list.length === 0) {
      return this.reply(source, {
        embeds: [EmbedManager.info('Blacklist Globale', 'La blacklist globale è vuota.')],
        ephemeral: isSlash
      }, isSlash);
    }

    const ITEMS_PER_PAGE = 5;
    const totalPages = calculatePages(list.length, ITEMS_PER_PAGE);
    let page = 0;

    const buildEmbed = (p) => {
      const slice = getPaginatedSlice(list, p, ITEMS_PER_PAGE);
      const fields = slice.map((e, i) => ({
        name: `#${p * ITEMS_PER_PAGE + i + 1} — ${e.username}`,
        value: [
          `**ID:** ${e.userId}`,
          `**Motivo:** ${e.reason}`,
          `**Aggiunto da:** ${e.moderatorTag}`,
          `**Data:** ${formatDate(e.addedAt)}`
        ].join('\n'),
        inline: false
      }));
      return EmbedManager.createEmbed({
        title: 'Blacklist Globale',
        color: 0x8B0000,
        fields,
        footer: { text: `Pagina ${p + 1}/${totalPages} | Totale: ${list.length}` },
        timestamp: true
      });
    };

    const buildRow = (p) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bl_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId('bl_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p === totalPages - 1)
    );

    let msg;
    const replyData = { embeds: [buildEmbed(0)], components: totalPages > 1 ? [buildRow(0)] : [] };

    if (isSlash) {
      await source.reply({ ...replyData, ephemeral: false });
      msg = await source.fetchReply();
    } else {
      msg = await source.channel.send(replyData);
    }

    if (totalPages <= 1) return;

    const authorId = isSlash ? source.user.id : source.author.id;
    const collector = msg.createMessageComponentCollector({ time: 60000 });

    collector.on('collect', async btn => {
      if (btn.user.id !== authorId) {
        return btn.reply({ embeds: [EmbedManager.error('Non Autorizzato', 'Non puoi usare questi bottoni.')], ephemeral: true });
      }
      if (btn.customId === 'bl_prev') page = Math.max(0, page - 1);
      if (btn.customId === 'bl_next') page = Math.min(totalPages - 1, page + 1);
      await btn.update({ embeds: [buildEmbed(page)], components: [buildRow(page)] });
    });

    collector.on('end', async () => { 
      try { 
        await msg.edit({ components: [] }); 
      } catch { 
        // Ignora errori di edit
      } 
    });
  }

  async checkBlacklist(source, targetUser, isSlash) {
    if (!targetUser) {
      return this.reply(source, {
        embeds: [EmbedManager.error('Errore', 'Utente non valido.')],
        ephemeral: isSlash
      }, isSlash);
    }

    const entry = this.storage.getBlacklistEntry(targetUser.id);
    if (!entry) {
      return this.reply(source, {
        embeds: [EmbedManager.success('Non in Blacklist', `${targetUser.username} NON è nella blacklist globale.`)],
        ephemeral: isSlash
      }, isSlash);
    }
    return this.reply(source, {
      embeds: [EmbedManager.createEmbed({
        title: 'Utente in Blacklist',
        color: 0x8B0000,
        fields: [
          { name: 'Utente', value: `${entry.username} (${entry.userId})`, inline: true },
          { name: 'Motivo', value: entry.reason, inline: false },
          { name: 'Aggiunto da', value: entry.moderatorTag, inline: true },
          { name: 'Data', value: formatDate(entry.addedAt), inline: true }
        ],
        timestamp: true
      })],
      ephemeral: isSlash
    }, isSlash);
  }

  async reply(source, data, isSlash) {
    if (isSlash) {
      if (source.replied || source.deferred) {
        return source.followUp(data);
      }
      return source.reply(data);
    }
    return source.channel.send(data);
  }
}

// ==================== COMMAND LOGIC ====================

class CommandLogic {
  static async getUserFromId(guild, userId) {
    try {
      return await guild.members.fetch(userId);
    } catch {
      return null;
    }
  }

  static async getTargetUser(client, input) {
    // Estrai l'ID dalla menzione se presente
    const userId = extractUserId(input);
    if (!userId) return null;
    
    try {
      return await client.users.fetch(userId);
    } catch {
      return null;
    }
  }

  static async kick(guild, executor, userId, reason = 'Nessun motivo') {
    if (!executor.permissions.has(PermissionsBitField.Flags.KickMembers)) 
      return { success: false, message: '❌ Non hai il permesso "Espelli Membri"!' };
    
    // Estrai l'ID dalla menzione
    const targetId = extractUserId(userId);
    if (!targetId) 
      return { success: false, message: '❌ ID utente non valido! Usa un ID numerico o menziona l\'utente.' };
    
    const member = await this.getUserFromId(guild, targetId);
    if (!member) return { success: false, message: '❌ Utente non trovato nel server!' };
    
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.KickMembers))
      return { success: false, message: '❌ Non ho il permesso "Espelli Membri"!' };
    
    if (member.id === botMember.id) 
      return { success: false, message: '❌ Non posso espellere me stesso!' };
    
    if (member.roles.highest.position >= botMember.roles.highest.position)
      return { success: false, message: '❌ Non posso espellere un utente con un ruolo più alto o uguale al mio!' };
    
    await member.kick(reason);
    return { success: true, message: `✅ Utente ${member.user.tag} (${targetId}) è stato espulso. Motivo: ${reason}` };
  }

  static async ban(guild, executor, userId, reason = 'Nessun motivo') {
    if (!executor.permissions.has(PermissionsBitField.Flags.BanMembers)) 
      return { success: false, message: '❌ Non hai il permesso "Banna Membri"!' };
    
    const targetId = extractUserId(userId);
    if (!targetId) 
      return { success: false, message: '❌ ID utente non valido! Usa un ID numerico o menziona l\'utente.' };
    
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.BanMembers))
      return { success: false, message: '❌ Non ho il permesso "Banna Membri"!' };
    
    if (targetId === botMember.id) 
      return { success: false, message: '❌ Non posso bannare me stesso!' };
    
    const member = await this.getUserFromId(guild, targetId);
    if (member && !member.bannable)
      return { success: false, message: '❌ Non posso bannare questo utente (ruolo troppo alto o mancano permessi)!' };
    
    await guild.members.ban(targetId, { reason });
    return { success: true, message: `✅ Utente con ID ${targetId} è stato bannato. Motivo: ${reason}` };
  }

  static async unban(guild, executor, userId) {
    if (!executor.permissions.has(PermissionsBitField.Flags.BanMembers)) 
      return { success: false, message: '❌ Non hai il permesso "Banna Membri"!' };
    
    const targetId = extractUserId(userId);
    if (!targetId) 
      return { success: false, message: '❌ ID utente non valido! Usa un ID numerico o menziona l\'utente.' };
    
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.BanMembers))
      return { success: false, message: '❌ Non ho il permesso "Banna Membri"!' };
    
    try {
      const ban = await guild.bans.fetch(targetId);
      if (!ban) return { success: false, message: '❌ Utente non bannato!' };
      
      await guild.bans.remove(targetId);
      return { success: true, message: `✅ Utente ${ban.user.tag} (${targetId}) è stato sbannato.` };
    } catch (error) {
      if (error.code === 10026) {
        return { success: false, message: '❌ Utente non trovato o non bannato.' };
      }
      throw error;
    }
  }

  static async clear(channel, executor, amount) {
    if (!executor.permissions.has(PermissionsBitField.Flags.ManageMessages)) 
      return { success: false, message: '❌ Non hai il permesso "Gestisci Messaggi"!' };
    
    if (amount < 1 || amount > 100) 
      return { success: false, message: '❌ Puoi cancellare tra 1 e 100 messaggi' };
    
    const botMember = channel.guild.members.me;
    if (!channel.permissionsFor(botMember).has(PermissionsBitField.Flags.ManageMessages)) {
      return { success: false, message: '❌ Non ho il permesso di gestire i messaggi in questo canale!' };
    }
    
    try {
      const deleted = await channel.bulkDelete(amount, true);
      return { success: true, message: `🧹 Cancellati ${deleted.size} messaggi` };
    } catch (error) {
      if (error.code === 50034) {
        return { success: false, message: '❌ Non posso cancellare messaggi più vecchi di 14 giorni. Usa un range più piccolo.' };
      }
      throw error;
    }
  }

  static async invite(interactionOrMessage, guild, executor, targetUserId, replyMethod) {
    if (!executor.permissions.has(PermissionsBitField.Flags.CreateInstantInvite)) {
      return replyMethod({ success: false, message: '❌ Non hai il permesso "Crea Invito"!' });
    }
    
    // Estrai l'ID dalla menzione
    const userId = extractUserId(targetUserId);
    if (!userId) {
      return replyMethod({ success: false, message: '❌ ID utente non valido! Usa un ID numerico o menziona l\'utente (@utente).' });
    }
    
    // Cerca l'utente usando botInstance
    let targetUser = null;
    
    // Prima cerca nel server
    try {
      const member = await guild.members.fetch(userId);
      if (member) {
        targetUser = member.user;
      }
    } catch (e) {
      // Non trovato nel server
    }
    
    // Se non trovato nel server, cerca globalmente usando il client
    if (!targetUser && botInstance) {
      try {
        targetUser = await botInstance.client.users.fetch(userId);
      } catch (err) {
        console.error('Errore fetch utente:', err);
      }
    }
    
    if (!targetUser) {
      return replyMethod({ success: false, message: '❌ Utente non trovato! Verifica l\'ID o la menzione.' });
    }
    
    const channel = interactionOrMessage.channel;
    
    if (!channel || !channel.isTextBased()) {
      return replyMethod({ success: false, message: '❌ Questo canale non supporta inviti.' });
    }
    
    const botMember = guild.members.me;
    if (!channel.permissionsFor(botMember).has(PermissionsBitField.Flags.CreateInstantInvite)) {
      return replyMethod({ success: false, message: `❌ Non ho il permesso di creare inviti in ${channel}.` });
    }
    
    try {
      const invite = await channel.createInvite({
        maxUses: 1,
        maxAge: 3600,
        unique: true,
        reason: `Invite richiesto da ${executor.user ? executor.user.tag : executor.username} per ${targetUser.username}`
      });
      
      const executorName = executor.user ? executor.user.tag : executor.username;
      const dmMessage = `${executorName} ti ha inviato un invito per il server **${guild.name}**\n${invite.url}\nValido per 1 utilizzo, scade tra 60 minuti.`;
      
      try {
        await targetUser.send(dmMessage);
        return replyMethod({ 
          success: true, 
          message: `✅ Invito inviato a ${targetUser.username}!` 
        });
      } catch (dmError) {
        // Se i DM sono chiusi, posta nel canale
        const fallbackMessage = `${targetUser}\n${executorName} ti ha inviato un invito per il server ${guild.name}\n${invite.url}\nValido per 1 utilizzo, scade tra 60 minuti.`;
        await channel.send(fallbackMessage);
        return replyMethod({ 
          success: true, 
          message: `⚠️ DM chiusi, invito postato in ${channel}` 
        });
      }
      
    } catch (error) {
      console.error('Errore creazione invito:', error);
      return replyMethod({ 
        success: false, 
        message: '❌ Errore durante la creazione dell\'invito.' 
      });
    }
  }

  static async addRole(guild, executor, targetUserId, roleId) {
    if (!executor.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return { success: false, message: '❌ Non hai il permesso "Gestisci Ruoli"!' };
    }

    const targetId = extractUserId(targetUserId);
    if (!targetId) {
      return { success: false, message: '❌ ID utente non valido!' };
    }

    const roleIdMatch = extractUserId(roleId);
    if (!roleIdMatch) {
      return { success: false, message: '❌ ID ruolo non valido!' };
    }

    const member = await this.getUserFromId(guild, targetId);
    if (!member) return { success: false, message: '❌ Utente non trovato nel server!' };

    const role = guild.roles.cache.get(roleIdMatch);
    if (!role) return { success: false, message: '❌ Ruolo non trovato!' };

    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return { success: false, message: '❌ Non ho il permesso "Gestisci Ruoli"!' };
    }

    if (role.position >= botMember.roles.highest.position) {
      return { success: false, message: '❌ Non posso assegnare un ruolo più alto o uguale al mio ruolo più alto!' };
    }

    if (member.roles.cache.has(roleIdMatch)) {
      return { success: false, message: `❌ L'utente ha già il ruolo ${role.name}!` };
    }

    await member.roles.add(role);
    return { success: true, message: `✅ Ruolo **${role.name}** assegnato a ${member.user.tag} (ID: ${targetId})!` };
  }

  static async removeRole(guild, executor, targetUserId, roleId) {
    if (!executor.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return { success: false, message: '❌ Non hai il permesso "Gestisci Ruoli"!' };
    }

    const targetId = extractUserId(targetUserId);
    if (!targetId) {
      return { success: false, message: '❌ ID utente non valido!' };
    }

    const roleIdMatch = extractUserId(roleId);
    if (!roleIdMatch) {
      return { success: false, message: '❌ ID ruolo non valido!' };
    }

    const member = await this.getUserFromId(guild, targetId);
    if (!member) return { success: false, message: '❌ Utente non trovato nel server!' };

    const role = guild.roles.cache.get(roleIdMatch);
    if (!role) return { success: false, message: '❌ Ruolo non trovato!' };

    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return { success: false, message: '❌ Non ho il permesso "Gestisci Ruoli"!' };
    }

    if (!member.roles.cache.has(roleIdMatch)) {
      return { success: false, message: `❌ L'utente non ha il ruolo ${role.name}!` };
    }

    await member.roles.remove(role);
    return { success: true, message: `✅ Ruolo **${role.name}** rimosso da ${member.user.tag} (ID: ${targetId})!` };
  }

  static async listRoles(guild) {
    const roles = guild.roles.cache
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => `**${r.name}** (ID: \`${r.id}\`) - ${r.members.size} membri`);
    
    if (roles.length === 0) return { success: false, message: '❌ Nessun ruolo trovato (escluso @everyone)!' };
    
    let messageText = `**📋 Lista Ruoli del Server (${roles.length} ruoli)**\n\n${roles.join('\n')}`;
    if (messageText.length > 2000) {
      messageText = `**📋 Lista Ruoli del Server (${roles.length} ruoli)**\n\n${roles.slice(0, 20).join('\n')}\n\n*...e altri ${roles.length - 20} ruoli*`;
    }
    
    return { success: true, message: messageText };
  }

  static async lockChannel(channel, executor, reason = 'Nessun motivo') {
    if (!executor.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, message: '❌ Non hai il permesso "Gestisci Canali"!' };
    }

    const botMember = channel.guild.members.me;
    if (!channel.permissionsFor(botMember).has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, message: '❌ Non ho il permesso di gestire questo canale!' };
    }

    const everyoneRole = channel.guild.roles.everyone;
    const currentPerms = channel.permissionOverwrites.cache.get(everyoneRole.id);
    if (currentPerms && currentPerms.deny.has(PermissionsBitField.Flags.SendMessages)) {
      return { success: false, message: '❌ Questo canale è già bloccato!' };
    }

    await channel.permissionOverwrites.edit(everyoneRole, {
      SendMessages: false
    });

    const executorName = executor.user ? executor.user.tag : executor.username;
    return { 
      success: true, 
      message: `🔒 **Canale bloccato!**\nMotivo: ${reason}\nDa: ${executorName}` 
    };
  }

  static async unlockChannel(channel, executor) {
    if (!executor.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, message: '❌ Non hai il permesso "Gestisci Canali"!' };
    }

    const botMember = channel.guild.members.me;
    if (!channel.permissionsFor(botMember).has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, message: '❌ Non ho il permesso di gestire questo canale!' };
    }

    const everyoneRole = channel.guild.roles.everyone;
    const currentPerms = channel.permissionOverwrites.cache.get(everyoneRole.id);
    if (!currentPerms || !currentPerms.deny.has(PermissionsBitField.Flags.SendMessages)) {
      return { success: false, message: '❌ Questo canale non è bloccato!' };
    }

    await channel.permissionOverwrites.delete(everyoneRole);

    const executorName = executor.user ? executor.user.tag : executor.username;
    return { 
      success: true, 
      message: `🔓 **Canale sbloccato!**\nDa: ${executorName}` 
    };
  }
}

// ==================== SLASH COMMANDS REGISTRATION ====================

const slashCommands = [
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Crea il pannello ticket'),
  new SlashCommandBuilder().setName('ticket').setDescription('Apre un ticket'),
  new SlashCommandBuilder().setName('close').setDescription('Chiude il ticket corrente'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Mostra info utente').addUserOption(opt => opt.setName('utente').setDescription('Utente da vedere')),
  new SlashCommandBuilder().setName('warn').setDescription('Warna un utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addStringOption(opt => opt.setName('motivo').setDescription('Motivo del warn')),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addIntegerOption(opt => opt.setName('secondi').setRequired(true).setDescription('Durata in secondi')).addStringOption(opt => opt.setName('motivo').setDescription('Motivo del timeout')),
  new SlashCommandBuilder().setName('modlogs').setDescription('Mostra log moderazione').addUserOption(opt => opt.setName('utente').setRequired(true)),
  new SlashCommandBuilder().setName('addcmd').setDescription('Aggiunge comando custom').addStringOption(opt => opt.setName('nome').setRequired(true)).addStringOption(opt => opt.setName('risposta').setRequired(true)),
  new SlashCommandBuilder().setName('delcmd').setDescription('Elimina comando custom').addStringOption(opt => opt.setName('nome').setRequired(true)),
  new SlashCommandBuilder().setName('dashboard').setDescription('Mostra dashboard'),
  new SlashCommandBuilder().setName('blacklist').setDescription('Gestione blacklist')
    .addSubcommand(sub => sub.setName('add').setDescription('Aggiungi alla blacklist').addUserOption(opt => opt.setName('utente').setRequired(true)).addStringOption(opt => opt.setName('motivo')))
    .addSubcommand(sub => sub.setName('remove').setDescription('Rimuovi dalla blacklist').addUserOption(opt => opt.setName('utente').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lista blacklist'))
    .addSubcommand(sub => sub.setName('check').setDescription('Controlla se in blacklist').addUserOption(opt => opt.setName('utente').setRequired(true))),
  // Comandi base aggiuntivi
  new SlashCommandBuilder().setName('kick').setDescription('Espelle un utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addStringOption(opt => opt.setName('motivo').setDescription('Motivo del kick')),
  new SlashCommandBuilder().setName('ban').setDescription('Banna un utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addStringOption(opt => opt.setName('motivo').setDescription('Motivo del ban')),
  new SlashCommandBuilder().setName('unban').setDescription('Sbanna un utente').addStringOption(opt => opt.setName('id').setRequired(true).setDescription('ID dell\'utente da sbannare')),
  new SlashCommandBuilder().setName('clear').setDescription('Cancella messaggi').addIntegerOption(opt => opt.setName('quantità').setRequired(true).setDescription('Numero di messaggi da cancellare (1-100)')),
  new SlashCommandBuilder().setName('invite').setDescription('Invia un invito a un utente (1 uso, 60 minuti)').addUserOption(opt => opt.setName('utente').setDescription('Utente a cui inviare l\'invito').setRequired(true)),
  new SlashCommandBuilder().setName('giverole').setDescription('Assegna un ruolo a un utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addRoleOption(opt => opt.setName('ruolo').setRequired(true)),
  new SlashCommandBuilder().setName('removerole').setDescription('Rimuove un ruolo da un utente').addUserOption(opt => opt.setName('utente').setRequired(true)).addRoleOption(opt => opt.setName('ruolo').setRequired(true)),
  new SlashCommandBuilder().setName('roles').setDescription('Mostra la lista dei ruoli del server'),
  new SlashCommandBuilder().setName('lock').setDescription('Blocca il canale').addStringOption(opt => opt.setName('motivo').setDescription('Motivo del blocco')),
  new SlashCommandBuilder().setName('unlock').setDescription('Sblocca il canale')
];

async function registerSlashCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log('🔄 Registrazione comandi slash...');
    await rest.put(Routes.applicationCommands(clientId), { body: slashCommands.map(cmd => cmd.toJSON()) });
    console.log('✅ Comandi slash registrati!');
  } catch (error) {
    console.error('❌ Errore registrazione comandi:', error);
  }
}

// ==================== MAIN BOT CLASS ====================

class DiscordBot {
  constructor() {
    this.token = TOKEN;
    this.modLogChannelId = MOD_LOG_CHANNEL_ID;
    this.clientId = CLIENT_ID;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.GuildVoiceStates
      ],
      partials: [Partials.Channel]
    });

    // IMPORTANTE: Salva l'istanza per usarla in CommandLogic
    botInstance = this;

    this.storage = new StorageService();
    this.modLogModule = new ModLogModule(this.client, this.modLogChannelId, this.storage);
    this.ticketModule = new TicketModule(this.modLogModule, this.client);
    this.lobbyModule = new LobbyModule(this.client);
    this.modLogsModule = new ModLogsModule(this.storage);
    this.blacklistModule = new BlacklistModule(this.storage, this.modLogModule, this.client);
  }

  async start() {
    await registerSlashCommands(this.clientId, this.token);
    this.setupEvents();
    await this.client.login(this.token);
  }

  setupEvents() {
    this.client.once(Events.ClientReady, () => {
      console.log(`✅ Bot online come ${this.client.user.tag}`);
      console.log(`📝 Comandi disponibili:`);
      console.log(`   Slash: /ticket, /close, /warn, /timeout, /userinfo, /modlogs, /blacklist, /addcmd, /delcmd, /dashboard, /ticketpanel, /kick, /ban, /unban, /clear, /invite, /giverole, /removerole, /roles, /lock, /unlock`);
      console.log(`   Prefisso: -, & (es. -help, -ticket, -warn @user, -bl add <id>)`);
    });

    this.client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction));
    this.client.on(Events.MessageCreate, (message) => this.handlePrefixCommand(message));
    this.client.on(Events.GuildMemberAdd, (member) => this.blacklistModule.handleGuildMemberAdd(member));

    process.on('unhandledRejection', console.error);
    process.on('uncaughtException', console.error);
  }

  async handlePrefixCommand(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const prefixes = ['-', '&'];
    const usedPrefix = prefixes.find(p => message.content.startsWith(p));
    if (!usedPrefix) return;

    const args = message.content.slice(usedPrefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const { guild, channel, member } = message;

    // Rate limiting per comandi prefix
    const cooldownCheck = checkCooldown(member.id, commandName);
    if (cooldownCheck.onCooldown) {
      return message.reply({
        content: `⏳ Aspetta ${cooldownCheck.remaining} secondi prima di usare di nuovo questo comando.`,
        allowedMentions: { repliedUser: false }
      });
    }

    const replyMethod = async (result) => {
      return message.reply({ content: result.message, allowedMentions: { repliedUser: false } });
    };

    try {
      switch (commandName) {
        // ===== COMANDI MODERAZIONE =====
        case 'kick': {
          const userId = args[0];
          if (!userId) return message.reply('❌ Uso: `-kick <user_id o @utente> [motivo]`');
          const reason = args.slice(1).join(' ') || 'Nessun motivo';
          const result = await CommandLogic.kick(guild, member, userId, reason);
          return replyMethod(result);
        }
        
        case 'ban': {
          const userId = args[0];
          if (!userId) return message.reply('❌ Uso: `-ban <user_id o @utente> [motivo]`');
          const reason = args.slice(1).join(' ') || 'Nessun motivo';
          const result = await CommandLogic.ban(guild, member, userId, reason);
          return replyMethod(result);
        }
        
        case 'unban': {
          const userId = args[0];
          if (!userId) return message.reply('❌ Uso: `-unban <user_id o @utente>`');
          const result = await CommandLogic.unban(guild, member, userId);
          return replyMethod(result);
        }
        
        case 'clear': {
          const amount = parseInt(args[0]);
          if (isNaN(amount)) return message.reply('❌ Uso: `-clear <1-100>`');
          const result = await CommandLogic.clear(channel, member, amount);
          return replyMethod(result);
        }
        
        case 'invite': {
          const userId = args[0];
          if (!userId) {
            return message.reply('❌ Uso: `-invite <user_id o @utente>`');
          }
          return CommandLogic.invite(message, guild, member, userId, replyMethod);
        }

        case 'giverole': {
          const userId = args[0];
          const roleId = args[1];
          if (!userId || !roleId) return message.reply('❌ Uso: `-giverole <user_id o @utente> <role_id>`');
          const result = await CommandLogic.addRole(guild, member, userId, roleId);
          return replyMethod(result);
        }

        case 'removerole': {
          const userId = args[0];
          const roleId = args[1];
          if (!userId || !roleId) return message.reply('❌ Uso: `-removerole <user_id o @utente> <role_id>`');
          const result = await CommandLogic.removeRole(guild, member, userId, roleId);
          return replyMethod(result);
        }

        case 'roles': {
          const result = await CommandLogic.listRoles(guild);
          return message.channel.send({ content: result.message });
        }

        case 'lock': {
          const reason = args.join(' ') || 'Nessun motivo';
          const result = await CommandLogic.lockChannel(channel, member, reason);
          return replyMethod(result);
        }

        case 'unlock': {
          const result = await CommandLogic.unlockChannel(channel, member);
          return replyMethod(result);
        }

        // ===== COMANDI TICKET =====
        case 'help': {
          const helpEmbed = new EmbedBuilder()
            .setTitle('📋 Comandi Disponibili')
            .setDescription('**Comandi con prefisso `-`**')
            .setColor('#0099ff')
            .addFields(
              { name: '🎫 Ticket', value: '`-ticket`, `-close`, `-ticketpanel`', inline: true },
              { name: '🛡️ Moderazione', value: '`-warn @user [motivo]`, `-timeout @user <secondi> [motivo]`, `-modlogs <id o @user>`', inline: true },
              { name: '🚫 Blacklist', value: '`-bl add <id o @user> [motivo]`, `-bl remove <id o @user>`, `-bl list`, `-bl check <id o @user>`', inline: true },
              { name: '📝 Custom', value: '`-addcmd <nome> <risposta>`, `-delcmd <nome>`', inline: true },
              { name: '👤 Utente', value: '`-userinfo [@user]`, `-dashboard`', inline: true },
              { name: '👢 Moderazione Base', value: '`-kick <id o @user> [motivo]`, `-ban <id o @user> [motivo]`, `-unban <id o @user>`, `-clear <1-100>`', inline: true },
              { name: '📨 Inviti & Ruoli', value: '`-invite <id o @utente>`, `-giverole <user o @user> <role>`, `-removerole <user o @user> <role>`, `-roles`', inline: true },
              { name: '🔒 Canali', value: '`-lock [motivo]`, `-unlock`', inline: true }
            )
            .setFooter({ text: 'Tutti i comandi supportano menzioni (@utente) e ID numerici' });
          return message.channel.send({ embeds: [helpEmbed] });
        }

        case 'addcmd': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });
          const cmdName = args.shift()?.toLowerCase();
          const response = args.join(' ');
          if (!cmdName || !response)
            return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -addcmd <nome> <risposta>')] });
          if (response.length > 4096)
            return message.reply({ embeds: [EmbedManager.error('Risposta Troppo Lunga', 'Massimo 4096 caratteri.')] });
          const customCommands = this.storage.loadCommands();
          customCommands[cmdName] = response;
          this.storage.saveCommands(customCommands);
          return message.reply({ embeds: [EmbedManager.success('Comando Aggiunto', `Comando "${cmdName}" aggiunto.`)] });
        }

        case 'delcmd': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });
          const cmdName = args.shift()?.toLowerCase();
          const customCommands = this.storage.loadCommands();
          if (!customCommands[cmdName])
            return message.reply({ embeds: [EmbedManager.error('Non Trovato', 'Comando non trovato.')] });
          delete customCommands[cmdName];
          this.storage.saveCommands(customCommands);
          return message.reply({ embeds: [EmbedManager.success('Comando Eliminato', `Comando "${cmdName}" eliminato.`)] });
        }

        case 'ticketpanel': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai i permessi necessari.')] });
          const button = new ButtonBuilder().setCustomId('create_ticket').setLabel('Apri Ticket').setStyle(ButtonStyle.Primary);
          const row = new ActionRowBuilder().addComponents(button);
          return message.channel.send({
            embeds: [EmbedManager.info('Pannello Ticket', 'Premi il bottone qui sotto per aprire un ticket.')],
            components: [row]
          });
        }

        case 'ticket': {
          return this.ticketModule.createTicket(message, message.author);
        }

        case 'close': {
          return this.ticketModule.closeTicket(message, message.author);
        }

        case 'userinfo': {
          let user = message.mentions.users.first();
          const userId = args[0];
          
          if (!user && userId) {
            const extractedId = extractUserId(userId);
            if (extractedId) {
              try { user = await this.client.users.fetch(extractedId); } catch {}
            }
          }
          
          if (!user) user = message.author;
          
          const memberInfo = message.guild.members.cache.get(user.id);
          const roles = getRoles(memberInfo, message.guild);
          return message.channel.send({
            embeds: [EmbedManager.info(`Info ${user.username}`, `Informazioni su ${user}`)
              .setThumbnail(user.displayAvatarURL({ dynamic: true }))
              .addFields(
                { name: 'ID', value: user.id, inline: true },
                { name: 'Bot', value: user.bot ? 'Sì' : 'No', inline: true },
                { name: 'Creato il', value: formatDate(user.createdAt), inline: true },
                { name: 'Entrato il', value: memberInfo ? formatDate(memberInfo.joinedAt) : 'N/A', inline: true },
                { name: 'Ruoli', value: roles, inline: false }
              )]
          });
        }

        case 'warn': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });
          
          let target = message.mentions.users.first();
          let targetId = args[0];
          
          if (!target && targetId) {
            const extractedId = extractUserId(targetId);
            if (extractedId) {
              try { target = await this.client.users.fetch(extractedId); } catch {}
            }
          }
          
          if (!target)
            return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -warn <@utente o ID> [motivo]')] });
          
          const memberTarget = message.guild.members.cache.get(target.id);
          if (!memberTarget) return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato nel server.')] });
          if (target.id === message.author.id) return message.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi warnare te stesso.')] });
          if (memberTarget.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi warnare un amministratore.')] });
          
          const reason = args.slice(1).join(' ') || 'Nessun motivo specificato';
          await this.modLogModule.logUserAction(message.guild, {
            type: 'Warn', title: 'Warn', targetId: target.id,
            target: `${target.username} (${target.id})`,
            moderator: `${message.author.username} (${message.author.id})`, reason
          });
          return message.channel.send({
            embeds: [EmbedManager.warning('Warn', 'Utente warnato con successo').addFields(
              { name: 'Utente', value: `${target.username} (${target.id})`, inline: true },
              { name: 'Moderatore', value: message.author.username, inline: true },
              { name: 'Motivo', value: reason, inline: false }
            )]
          });
        }

        case 'timeout': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });
          
          let target = message.mentions.users.first();
          let targetId = args[0];
          
          if (!target && targetId) {
            const extractedId = extractUserId(targetId);
            if (extractedId) {
              try { target = await this.client.users.fetch(extractedId); } catch {}
            }
          }
          
          const seconds = parseInt(args[1]);
          if (!target || isNaN(seconds))
            return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -timeout <@utente o ID> <secondi> [motivo]')] });
          
          const memberTarget = message.guild.members.cache.get(target.id);
          if (!memberTarget) return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato nel server.')] });
          if (target.id === message.author.id) return message.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi mettere in timeout te stesso.')] });
          if (memberTarget.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi mettere in timeout un amministratore.')] });
          
          const botMember = message.guild.members.me;
          if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
            return message.reply({ embeds: [EmbedManager.error('Permessi Insufficienti', 'Il bot non ha il permesso "Modera Membri".')] });
          }
          
          const reason = args.slice(2).join(' ') || 'Nessun motivo specificato';
          try { await memberTarget.timeout(seconds * 1000, reason); }
          catch { return message.reply({ embeds: [EmbedManager.error('Errore', 'Non posso mettere in timeout questo utente (ruolo troppo alto?).')] }); }
          
          const durata = formatDuration(seconds);
          await this.modLogModule.logUserAction(message.guild, {
            type: 'Timeout', title: 'Timeout', targetId: target.id,
            target: `${target.username} (${target.id})`,
            moderator: `${message.author.username} (${message.author.id})`, reason, duration: durata
          });
          return message.channel.send({
            embeds: [EmbedManager.createEmbed({
              title: 'Timeout',
              color: 0xFFA500,
              fields: [
                { name: 'Utente', value: `${target.username} (${target.id})`, inline: true },
                { name: 'Moderatore', value: message.author.username, inline: true },
                { name: 'Durata', value: durata, inline: true },
                { name: 'Motivo', value: reason, inline: false }
              ],
              timestamp: true
            })]
          });
        }

        case 'modlogs':
        case 'md': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });
          
          let targetId = args[0];
          if (!targetId)
            return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -modlogs <id o @utente>')] });
          
          const extractedId = extractUserId(targetId);
          if (!extractedId)
            return message.reply({ embeds: [EmbedManager.error('ID Non Valido', 'L\'ID deve essere numerico e tra 17-20 caratteri.')] });
          
          let target;
          try { target = await this.client.users.fetch(extractedId); }
          catch { return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato.')] }); }
          
          return this.modLogsModule.handleModlogs(message, target, false);
        }

        case 'dashboard': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai i permessi necessari.')] });
          const button = new ButtonBuilder().setCustomId('create_lobby').setLabel('Crea Lobby').setStyle(ButtonStyle.Primary);
          const row = new ActionRowBuilder().addComponents(button);
          return message.channel.send({
            embeds: [EmbedManager.info('Crea Lobby', 'Clicca il bottone qui sotto per creare una nuova lobby privata.')],
            components: [row]
          });
        }

        case 'bl':
        case 'blacklist': {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')] });

          const sub = args.shift()?.toLowerCase();

          if (sub === 'add') {
            let targetId = args[0];
            if (!targetId) return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -bl add <id o @utente> [motivo]')] });
            
            const extractedId = extractUserId(targetId);
            if (!extractedId) return message.reply({ embeds: [EmbedManager.error('ID Non Valido', 'L\'ID deve essere numerico e tra 17-20 caratteri.')] });
            
            let target;
            try { target = await this.client.users.fetch(extractedId); }
            catch { return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato.')] }); }
            const reason = args.slice(1).join(' ') || 'Nessun motivo specificato';
            return this.blacklistModule.addBlacklist(message, target, reason, message.author, false);
          }

          if (sub === 'remove' || sub === 'rm') {
            let targetId = args[0];
            if (!targetId) return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -bl remove <id o @utente>')] });
            
            const extractedId = extractUserId(targetId);
            if (!extractedId) return message.reply({ embeds: [EmbedManager.error('ID Non Valido', 'L\'ID deve essere numerico e tra 17-20 caratteri.')] });
            
            let target;
            try { target = await this.client.users.fetch(extractedId); }
            catch { return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato.')] }); }
            return this.blacklistModule.removeBlacklist(message, target, message.author, false);
          }

          if (sub === 'check' || sub === 'info') {
            let targetId = args[0];
            if (!targetId) return message.reply({ embeds: [EmbedManager.error('Errore Sintassi', 'Uso: -bl check <id o @utente>')] });
            
            const extractedId = extractUserId(targetId);
            if (!extractedId) return message.reply({ embeds: [EmbedManager.error('ID Non Valido', 'L\'ID deve essere numerico e tra 17-20 caratteri.')] });
            
            let target;
            try { target = await this.client.users.fetch(extractedId); }
            catch { return message.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato.')] }); }
            return this.blacklistModule.checkBlacklist(message, target, false);
          }

          if (sub === 'list') {
            return this.blacklistModule.listBlacklist(message, false);
          }

          return message.reply({
            embeds: [EmbedManager.info('Blacklist - Comandi', [
              '`-bl add <id o @utente> [motivo]` — Aggiunge alla blacklist globale',
              '`-bl remove <id o @utente>` — Rimuove dalla blacklist globale',
              '`-bl list` — Mostra la lista completa',
              '`-bl check <id o @utente>` — Controlla se un utente è in blacklist'
            ].join('\n'))]
          });
        }
      }
    } catch (err) {
      console.error('Errore prefix command:', err);
      return message.reply('❌ Errore durante l\'esecuzione del comando.');
    }
  }

  async handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand()) await this.handleSlashCommand(interaction);
      else if (interaction.isButton()) await this.handleButton(interaction);
    } catch (err) {
      console.error(err);
      const errorEmbed = EmbedManager.error('Errore', "Errore durante l'interazione.");
      if (interaction.replied || interaction.deferred) await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      else await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    }
  }

  async handleSlashCommand(interaction) {
    const { commandName } = interaction;

    switch (commandName) {
      case 'ticketpanel':
        return this.executeTicketPanel(interaction);
      case 'ticket':
        return this.ticketModule.createTicket(interaction, interaction.user);
      case 'close':
        return this.ticketModule.closeTicket(interaction, interaction.user);
      case 'userinfo':
        return this.executeUserinfo(interaction);
      case 'warn':
        return this.executeWarn(interaction);
      case 'timeout':
        return this.executeTimeout(interaction);
      case 'modlogs':
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')], ephemeral: true });
        const target = interaction.options.getUser('utente');
        return this.modLogsModule.handleModlogs(interaction, target, true);
      case 'addcmd':
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')], ephemeral: true });
        const cmdName = interaction.options.getString('nome').toLowerCase();
        const response = interaction.options.getString('risposta');
        if (response.length > 4096)
          return interaction.reply({ embeds: [EmbedManager.error('Risposta Troppo Lunga', 'Massimo 4096 caratteri.')], ephemeral: true });
        const customCommands = this.storage.loadCommands();
        customCommands[cmdName] = response;
        this.storage.saveCommands(customCommands);
        return interaction.reply({ embeds: [EmbedManager.success('Comando Aggiunto', `Comando "${cmdName}" aggiunto.`)], ephemeral: true });
      case 'delcmd':
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')], ephemeral: true });
        const delCmdName = interaction.options.getString('nome').toLowerCase();
        const cmds = this.storage.loadCommands();
        if (!cmds[delCmdName])
          return interaction.reply({ embeds: [EmbedManager.error('Non Trovato', `Comando "${delCmdName}" non trovato.`)], ephemeral: true });
        delete cmds[delCmdName];
        this.storage.saveCommands(cmds);
        return interaction.reply({ embeds: [EmbedManager.success('Comando Eliminato', `Comando "${delCmdName}" eliminato.`)], ephemeral: true });
      case 'dashboard':
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai i permessi necessari.')], ephemeral: true });
        const button = new ButtonBuilder().setCustomId('create_lobby').setLabel('Crea Lobby').setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(button);
        return interaction.reply({
          embeds: [EmbedManager.info('Crea Lobby', 'Clicca il bottone qui sotto per creare una nuova lobby privata.')],
          components: [row]
        });
      case 'blacklist':
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Solo admin possono usare questo comando.')], ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const user = interaction.options.getUser('utente');
          const reason = interaction.options.getString('motivo') || 'Nessun motivo specificato';
          return this.blacklistModule.addBlacklist(interaction, user, reason, interaction.user, true);
        }
        if (sub === 'remove') {
          const user = interaction.options.getUser('utente');
          return this.blacklistModule.removeBlacklist(interaction, user, interaction.user, true);
        }
        if (sub === 'list') {
          return this.blacklistModule.listBlacklist(interaction, true);
        }
        if (sub === 'check') {
          const user = interaction.options.getUser('utente');
          return this.blacklistModule.checkBlacklist(interaction, user, true);
        }
        break;

      case 'kick': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.KickMembers))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Espelli Membri"!')], ephemeral: true });
        const user = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo') || 'Nessun motivo';
        const result = await CommandLogic.kick(interaction.guild, interaction.member, user.id, reason);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'ban': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Banna Membri"!')], ephemeral: true });
        const user = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo') || 'Nessun motivo';
        const result = await CommandLogic.ban(interaction.guild, interaction.member, user.id, reason);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'unban': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Banna Membri"!')], ephemeral: true });
        const userId = interaction.options.getString('id');
        const result = await CommandLogic.unban(interaction.guild, interaction.member, userId);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'clear': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Gestisci Messaggi"!')], ephemeral: true });
        const amount = interaction.options.getInteger('quantità');
        const result = await CommandLogic.clear(interaction.channel, interaction.member, amount);
        if (result.success) {
          await interaction.reply({ content: result.message, ephemeral: true });
          setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
        } else {
          await interaction.reply({ content: result.message, ephemeral: true });
        }
        break;
      }

      case 'invite': {
        const user = interaction.options.getUser('utente');
        const replyMethodSlash = async (result) => {
          return interaction.reply({ content: result.message, ephemeral: !result.success });
        };
        return CommandLogic.invite(interaction, interaction.guild, interaction.member, user.id, replyMethodSlash);
      }

      case 'giverole': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Gestisci Ruoli"!')], ephemeral: true });
        const user = interaction.options.getUser('utente');
        const role = interaction.options.getRole('ruolo');
        const result = await CommandLogic.addRole(interaction.guild, interaction.member, user.id, role.id);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'removerole': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Gestisci Ruoli"!')], ephemeral: true });
        const user = interaction.options.getUser('utente');
        const role = interaction.options.getRole('ruolo');
        const result = await CommandLogic.removeRole(interaction.guild, interaction.member, user.id, role.id);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'roles': {
        const result = await CommandLogic.listRoles(interaction.guild);
        return interaction.reply({ content: result.message, ephemeral: true });
      }

      case 'lock': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Gestisci Canali"!')], ephemeral: true });
        const reason = interaction.options.getString('motivo') || 'Nessun motivo';
        const result = await CommandLogic.lockChannel(interaction.channel, interaction.member, reason);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }

      case 'unlock': {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels))
          return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai il permesso "Gestisci Canali"!')], ephemeral: true });
        const result = await CommandLogic.unlockChannel(interaction.channel, interaction.member);
        return interaction.reply({ content: result.message, ephemeral: !result.success });
      }
    }
  }

  async executeTicketPanel(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ embeds: [EmbedManager.error('Accesso Negato', 'Non hai i permessi necessari.')], ephemeral: true });
    }
    const button = new ButtonBuilder().setCustomId('create_ticket').setLabel('Apri Ticket').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    return interaction.reply({
      embeds: [EmbedManager.info('Pannello Ticket', 'Premi il bottone qui sotto per aprire un ticket.')],
      components: [row]
    });
  }

  async executeUserinfo(interaction) {
    const user = interaction.options.getUser('utente') || interaction.user;
    const member = interaction.guild.members.cache.get(user.id);
    const roles = getRoles(member, interaction.guild);

    return interaction.reply({
      embeds: [EmbedManager.info(`Info ${user.username}`, `Informazioni su ${user}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Sì' : 'No', inline: true },
          { name: 'Creato il', value: formatDate(user.createdAt), inline: true },
          { name: 'Entrato il', value: member ? formatDate(member.joinedAt) : 'N/A', inline: true },
          { name: 'Ruoli', value: roles, inline: false }
        )]
    });
  }

  async executeWarn(interaction) {
    const target = interaction.options.getUser('utente');
    const reason = interaction.options.getString('motivo') || 'Nessun motivo specificato';
    const member = interaction.guild.members.cache.get(target.id);

    if (!member) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato nel server.')], ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi warnare te stesso.')], ephemeral: true });
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi warnare un amministratore.')], ephemeral: true });

    await this.modLogModule.logUserAction(interaction.guild, {
      type: 'Warn', title: 'Warn',
      targetId: target.id, target: `${target.username} (${target.id})`,
      moderator: `${interaction.user.username} (${interaction.user.id})`, reason
    });

    return interaction.reply({
      embeds: [EmbedManager.warning('Warn', 'Utente warnato con successo').addFields(
        { name: 'Utente', value: `${target.username} (${target.id})`, inline: true },
        { name: 'Moderatore', value: interaction.user.username, inline: true },
        { name: 'Motivo', value: reason, inline: false }
      )]
    });
  }

  async executeTimeout(interaction) {
    const target = interaction.options.getUser('utente');
    const seconds = interaction.options.getInteger('secondi');
    const reason = interaction.options.getString('motivo') || 'Nessun motivo specificato';
    const member = interaction.guild.members.cache.get(target.id);

    if (!member) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Utente non trovato nel server.')], ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi mettere in timeout te stesso.')], ephemeral: true });
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Non puoi mettere in timeout un amministratore.')], ephemeral: true });

    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return interaction.reply({ embeds: [EmbedManager.error('Permessi Insufficienti', 'Il bot non ha il permesso "Modera Membri".')], ephemeral: true });
    }

    try {
      await member.timeout(seconds * 1000, reason);
    } catch (err) {
      return interaction.reply({ embeds: [EmbedManager.error('Errore', 'Non posso mettere in timeout questo utente (ruolo troppo alto?).')], ephemeral: true });
    }

    const durata = formatDuration(seconds);
    await this.modLogModule.logUserAction(interaction.guild, {
      type: 'Timeout', title: 'Timeout',
      targetId: target.id, target: `${target.username} (${target.id})`,
      moderator: `${interaction.user.username} (${interaction.user.id})`, reason, duration: durata
    });

    return interaction.reply({
      embeds: [EmbedManager.createEmbed({
        title: 'Timeout',
        color: 0xFFA500,
        fields: [
          { name: 'Utente', value: `${target.username} (${target.id})`, inline: true },
          { name: 'Moderatore', value: interaction.user.username, inline: true },
          { name: 'Durata', value: durata, inline: true },
          { name: 'Motivo', value: reason, inline: false }
        ],
        timestamp: true
      })]
    });
  }

  async handleButton(interaction) {
    if (interaction.customId === 'create_ticket') {
      return this.ticketModule.createTicket(interaction, interaction.user);
    }
    if (interaction.customId === 'close_ticket') {
      return this.ticketModule.closeTicket(interaction, interaction.user);
    }
    if (interaction.customId === 'create_lobby') {
      return this.lobbyModule.createLobby(interaction);
    }
  }
}

// ==================== STARTUP ====================

const bot = new DiscordBot();
bot.start().then(() => {
  console.log('✅ Bot avviato con successo');
  // Avvia la dashboard se esiste
  try {
    const { startDashboard } = require('./dashboard');
    startDashboard(bot.client);
  } catch (e) {
    console.log('ℹ️ Dashboard non disponibile');
  }
}).catch(err => {
  console.error('❌ Errore avvio bot:', err);
  process.exit(1);
});
