import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice';
import {
    getJoinToCreateConfig, 
    registerTemporaryChannel, 
    unregisterTemporaryChannel,
    getTemporaryChannelInfo,
    formatChannelName
} from '../utils/database.js';
import { sanitizeInput } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import { handleMusicVoiceState } from '../services/music/musicVoiceState.js';

// --- BEÁLLÍTÁSOK ---
const VERIFICATION_CHANNEL_ID = '1548329936417333249';
const VERIFIED_ROLE_ID = '1548319564163584006';
const AUDIO_FILE_PATH = './verification.mp3';

const channelCreationCooldown = new Map();
const VOICE_CREATE_COOLDOWN_MS = 2000;
const DEFAULT_VOICE_BITRATE = 64000;
const MAX_VOICE_BITRATE = 384000;
const MIN_VOICE_BITRATE = 8000;
const MAX_CHANNEL_NAME_LENGTH = 100;
const FALLBACK_CHANNEL_NAME = 'Voice Room';
const MAX_TRACKED_COOLDOWNS = 10000;

export default {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        if (newState.member.user.bot) return;

        const guildId = newState.guild.id;
        const userId = newState.member.id;
        const cooldownKey = `${guildId}-${userId}`;
        cleanupCooldownEntries();

        // === 1. VOICE VERIFICATION RENDSZER ===
        
        // Biztosítjuk, hogy a bot folyamatosan bent legyen a verifikációs csatornában
        let connection = getVoiceConnection(newState.guild.id);
        const verifyChannel = newState.guild.channels.cache.get(VERIFICATION_CHANNEL_ID);

        if (verifyChannel && !connection) {
            try {
                connection = joinVoiceChannel({
                    channelId: VERIFICATION_CHANNEL_ID,
                    guildId: newState.guild.id,
                    adapterCreator: newState.guild.voiceAdapterCreator,
                });
            } catch (err) {
                logger.error('Hiba a verifikációs csatornához való csatlakozáskor:', err);
            }
        }

        // Ha egy felhasználó BELÉP a verifikációs csatornába
        if (newState.channel && newState.channel.id === VERIFICATION_CHANNEL_ID && oldState.channel?.id !== VERIFICATION_CHANNEL_ID) {
            handleVoiceVerification(newState, connection);
        }

        // === 2. JOIN-TO-CREATE ÉS DISCORD LOGIKA ===
        try {
            const config = await getJoinToCreateConfig(client, guildId);

            if (config && config.enabled && config.triggerChannels && config.triggerChannels.length > 0) {
                if (!oldState.channel && newState.channel) {
                    await handleVoiceJoin(client, newState, config);
                }

                if (oldState.channel && !newState.channel) {
                    await handleVoiceLeave(client, oldState, config);
                }

                if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                    await handleVoiceMove(client, oldState, newState, config);
                }
            }

        } catch (error) {
            logger.error(`Error in voiceStateUpdate for guild ${guildId}:`, error);
        }

        // Voice verification kezelő függvény
        async function handleVoiceVerification(state, currentConnection) {
            try {
                if (!currentConnection) {
                    currentConnection = joinVoiceChannel({
                        channelId: state.channel.id,
                        guildId: state.guild.id,
                        adapterCreator: state.guild.voiceAdapterCreator,
                    });
                }

                const player = createAudioPlayer();
                const resource = createAudioResource(AUDIO_FILE_PATH);

                player.play(resource);
                currentConnection.subscribe(player);

                // Amikor a bot befejezi a beszédet
                player.on(AudioPlayerStatus.Idle, async () => {
                    try {
                        // 1. Rang hozzáadása
                        const role = state.guild.roles.cache.get(VERIFIED_ROLE_ID);
                        if (role) {
                            await state.member.roles.add(role);
                            logger.info(`Verified Member role successfully added to ${state.member.user.tag}`);
                        } else {
                            logger.warn(`Verification role (${VERIFIED_ROLE_ID}) not found in guild ${state.guild.id}`);
                        }

                        // 2. Felhasználó lecsatlakoztatása (Disconnect) a Voice csatornából
                        if (state.member.voice.channel) {
                            await state.member.voice.disconnect();
                            logger.info(`User ${state.member.user.tag} disconnected from voice after verification.`);
                        }
                    } catch (err) {
                        logger.error(`Failed during post-verification actions for ${state.member.user.tag}:`, err);
                    }
                });

                player.on('error', (err) => {
                    logger.error('Audio player error during verification:', err);
                });

            } catch (err) {
                logger.error(`Voice verification failed for user ${state.member.id}:`, err);
            }
        }

        async function handleVoiceJoin(client, state, config) {
            const { channel, member } = state;

            if (!config.triggerChannels.includes(channel.id)) {
                return;
            }

            const now = Date.now();
            if (channelCreationCooldown.has(cooldownKey)) {
                const lastCreation = channelCreationCooldown.get(cooldownKey);
                if (now - lastCreation < VOICE_CREATE_COOLDOWN_MS) {
                    logger.warn(`User ${member.id} is on cooldown for channel creation`);
                    return;
                }
            }

            const existingTempChannel = Object.keys(config.temporaryChannels || {}).find(
                tempChannelId => {
                    const tempInfo = config.temporaryChannels[tempChannelId];
                    return tempInfo && tempInfo.ownerId === member.id;
                }
            );

            if (existingTempChannel) {
                const tempChannel = state.guild.channels.cache.get(existingTempChannel);
                if (tempChannel) {
                    try {
                        await member.voice.setChannel(tempChannel);
                        return;
                    } catch (error) {
                        logger.warn(`Failed to move user ${member.id} to existing channel ${existingTempChannel}:`, error);
                    }
                }
            }

            if (member.voice.channel?.id !== channel.id) {
                return;
            }

            channelCreationCooldown.set(cooldownKey, now);
            trimCooldownMapIfNeeded();

            await createTemporaryChannel(client, state, config);
        }

        async function handleVoiceLeave(client, state, config) {
            const { channel, member } = state;

            const tempChannelInfo = await getTemporaryChannelInfo(client, state.guild.id, channel.id);
            
            if (!tempChannelInfo) {
                return;
            }

            if (channel.members.size === 0) {
                await deleteTemporaryChannel(client, channel, state.guild.id);
            } else if (tempChannelInfo.ownerId === member.id) {
                const nextMember = channel.members.first();
                if (nextMember) {
                    await transferChannelOwnership(client, channel, state.guild.id, nextMember.id);
                }
            }
        }

        async function handleVoiceMove(client, oldState, newState, config) {
            if (oldState.channel) {
                const tempChannelInfo = await getTemporaryChannelInfo(client, oldState.guild.id, oldState.channel.id);
                
                if (tempChannelInfo) {
                    if (oldState.channel.members.size === 0) {
                        await deleteTemporaryChannel(client, oldState.channel, oldState.guild.id);
                    } else if (tempChannelInfo.ownerId === oldState.member.id) {
                        const nextMember = oldState.channel.members.first();
                        if (nextMember) {
                            await transferChannelOwnership(client, oldState.channel, oldState.guild.id, nextMember.id);
                        }
                    }
                }
            }

            if (config.triggerChannels.includes(newState.channel.id) && 
                !config.triggerChannels.includes(oldState.channel?.id)) {
                await handleVoiceJoin(client, newState, config);
            }
        }

        async function createTemporaryChannel(client, state, config) {
            const { channel: triggerChannel, member, guild } = state;

            try {
                const me = guild.members.me;
                if (!me) {
                    logger.warn(`Bot member cache unavailable while creating temporary channel in guild ${guild.id}`);
                    channelCreationCooldown.delete(cooldownKey);
                    return;
                }

                const triggerPermissions = triggerChannel.permissionsFor(me);
                if (!triggerPermissions?.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect])) {
                    logger.warn(`Missing required permissions for temporary channel creation in guild ${guild.id} (trigger channel ${triggerChannel.id})`);
                    channelCreationCooldown.delete(cooldownKey);
                    return;
                }

                const channelOptions = config.channelOptions?.[triggerChannel.id] || {};
                const nameTemplate = channelOptions.nameTemplate || config.channelNameTemplate || "{username}'s Room";
                
                let userLimit = channelOptions.userLimit ?? config.userLimit ?? 0;
                const bitrate = clampVoiceBitrate(channelOptions.bitrate ?? config.bitrate ?? DEFAULT_VOICE_BITRATE);

                userLimit = Math.max(0, Math.min(99, userLimit || 0));

                logger.info(`Creating temporary channel for user ${member.id} with user limit: ${userLimit}`);

                const existingChannels = guild.channels.cache.filter(c =>
                    c.parentId === triggerChannel.parentId &&
                    c.name.startsWith(triggerChannel.name)
                ).size;

                let finalName;

                if (
                    nameTemplate.includes('{username}') ||
                    nameTemplate.includes('{displayName}')
                ) {
                    finalName = formatChannelName(nameTemplate, {
                        username: member.user.username,
                        userTag: member.user.tag,
                        displayName: member.displayName,
                        guildName: guild.name,
                        channelName: triggerChannel.name
                    });
                } else {
                    finalName = `${triggerChannel.name} ${existingChannels + 1}`;
                }

                const channelName = sanitizeVoiceChannelName(finalName);

                if (!member.voice?.channel || member.voice.channel.id !== triggerChannel.id) {
                    logger.debug(`Member ${member.id} no longer in trigger channel ${triggerChannel.id}, aborting temporary channel creation`);
                    channelCreationCooldown.delete(cooldownKey);
                    return;
                }

                const tempChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildVoice,
                    parent: triggerChannel.parentId,
                    userLimit: userLimit === 0 ? undefined : userLimit,
                    bitrate: bitrate,
                    permissionOverwrites: [
                        {
                            id: member.id,
                            allow: ['Connect', 'Speak', 'PrioritySpeaker', 'MoveMembers']
                        },
                        {
                            id: guild.id,
                            allow: ['Connect', 'Speak']
                        }
                    ]
                });

                await registerTemporaryChannel(client, guild.id, tempChannel.id, member.id, triggerChannel.id);

                if (member.voice?.channel?.id === triggerChannel.id) {
                    await member.voice.setChannel(tempChannel);
                } else {
                    logger.debug(`Skipped moving ${member.id} to temporary channel ${tempChannel.id} because voice state changed`);
                }

                logger.info(`Created temporary voice channel ${tempChannel.name} (${tempChannel.id}) for user ${member.user.tag} in guild ${guild.name} with user limit ${userLimit}`);

            } catch (error) {
                logger.error(`Failed to create temporary channel for user ${member.user.tag} in guild ${guild.name}:`, error);
                
                channelCreationCooldown.delete(cooldownKey);
                
                try {
                    await member.send({
                        content: `❌ Failed to create your temporary voice channel. Please contact a server administrator.`
                    });
                } catch (dmError) {
                    logger.debug(`Unable to send temporary channel failure DM to user ${member.id}:`, dmError);
                }
            }
        }

        async function deleteTemporaryChannel(client, channel, guildId) {
            try {
                await unregisterTemporaryChannel(client, guildId, channel.id);

                await channel.delete('Temporary voice channel - empty');

                logger.info(`Deleted temporary voice channel ${channel.name} (${channel.id}) in guild ${channel.guild.name}`);

            } catch (error) {
                logger.error(`Failed to delete temporary channel ${channel.id}:`, error);
            }
        }

        async function transferChannelOwnership(client, channel, guildId, newOwnerId) {
            try {
                const config = await getJoinToCreateConfig(client, guildId);
                const tempChannelInfo = config.temporaryChannels[channel.id];
                
                if (!tempChannelInfo) return;

                config.temporaryChannels[channel.id].ownerId = newOwnerId;
                await client.db.set(`guild:${guildId}:jointocreate`, config);

                const newOwner = await channel.guild.members.fetch(newOwnerId);
                if (newOwner) {
                    const channelOptions = config.channelOptions?.[tempChannelInfo.triggerChannelId] || {};
                    const nameTemplate = channelOptions.nameTemplate || config.channelNameTemplate;
                    
                    const newChannelName = sanitizeVoiceChannelName(formatChannelName(nameTemplate, {
                        username: newOwner.user.username,
                        userTag: newOwner.user.tag,
                        displayName: newOwner.displayName,
                        guildName: channel.guild.name,
                        channelName: channel.guild.channels.cache.get(tempChannelInfo.triggerChannelId)?.name || 'Voice Channel'
                    }));

                    await channel.setName(newChannelName);
                }

                logger.info(`Transferred ownership of temporary channel ${channel.id} to user ${newOwnerId}`);

            } catch (error) {
                logger.error(`Failed to transfer ownership of channel ${channel.id}:`, error);
            }
        }

        if (client.config?.features?.music) {
            handleMusicVoiceState(client, oldState, newState).catch((error) => {
                logger.error('Music voice state handler error:', error);
            });
        }
    }
};

function sanitizeVoiceChannelName(inputName) {
    const safeName = sanitizeInput(String(inputName || ''), MAX_CHANNEL_NAME_LENGTH)
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return safeName || FALLBACK_CHANNEL_NAME;
}

function clampVoiceBitrate(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_VOICE_BITRATE;
    }

    return Math.max(MIN_VOICE_BITRATE, Math.min(MAX_VOICE_BITRATE, Math.floor(parsed)));
}

function cleanupCooldownEntries() {
    const now = Date.now();
    for (const [key, timestamp] of channelCreationCooldown.entries()) {
        if (now - timestamp >= VOICE_CREATE_COOLDOWN_MS) {
            channelCreationCooldown.delete(key);
        }
    }
}

function trimCooldownMapIfNeeded() {
    if (channelCreationCooldown.size <= MAX_TRACKED_COOLDOWNS) {
        return;
    }

    const entries = [...channelCreationCooldown.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = channelCreationCooldown.size - MAX_TRACKED_COOLDOWNS;
    for (let index = 0; index < removeCount; index += 1) {
        channelCreationCooldown.delete(entries[index][0]);
    }
}
