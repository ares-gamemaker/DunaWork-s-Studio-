const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const path = require('path');

const VERIFICATION_CHANNEL_ID = '1548329936417333249';
const VERIFIED_ROLE_ID = '1548319564163584006';

module.exports = async (client, oldState, newState) => {
    // 1. Érzékeli egyáltalán a bot a mozgást?
    if (!oldState.channelId && newState.channelId) {
        console.log(`[TEST] Valaki belépett egy hangcsatornába! Csatorna ID: ${newState.channelId}`);
    }

    // Ha nem a megadott verifikációs csatornába lépett be, kilépünk
    if (newState.channelId !== VERIFICATION_CHANNEL_ID) return;

    const member = newState.member;
    if (member.user.bot) return;

    // Ha már megvan a rangja, ne fusson le
    if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
        console.log(`[TEST] ${member.user.tag} már ellenőrizve van.`);
        return;
    }

    console.log(`[TEST] Belépés érzékelve a verifikációs csatornába! Csatlakozás kísérlete...`);

    try {
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
        });

        const player = createAudioPlayer();
        const resourcePath = path.join(__dirname, '../../verification.mp3'); // ellenőrizd az mp3 útvonalát!
        const resource = createAudioResource(resourcePath);

        player.play(resource);
        connection.subscribe(player);

        console.log(`[TEST] Lejátszás elindítva!`);

        player.on(AudioPlayerStatus.Idle, async () => {
            console.log(`[TEST] Lejátszás kész, rang kiosztása...`);
            try {
                await member.roles.add(VERIFIED_ROLE_ID);
                await member.voice.disconnect();
                console.log(`[TEST] Sikeres verifikáció!`);
            } catch (e) {
                console.error(`[HIBA] Nem sikerült a rangot odaadni vagy lecsatlakoztatni:`, e);
            }
            connection.destroy();
        });

    } catch (error) {
        console.error(`[HIBA] Csatlakozási hiba:`, error);
    }
};
