import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERIFICATION_CHANNEL_ID = '1548329936417333249';
const VERIFIED_ROLE_ID = '1548319564163584006';

export default async function voiceStateUpdate(client, oldState, newState) {
    if (!oldState.channelId && newState.channelId) {
        console.log(`[TEST] Valaki belépett egy hangcsatornába! Csatorna ID: ${newState.channelId}`);
    }

    if (newState.channelId !== VERIFICATION_CHANNEL_ID) return;

    const member = newState.member;
    if (member.user.bot) return;

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
        const resourcePath = path.join(__dirname, '../../verification.mp3');
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
}
