package curio.quiet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.class_2561;
import net.minecraft.class_2588;

/**
 * Curio quiet reconnect: the agent bot restarts to pick up new code, which makes the server broadcast
 * "X left the game" / "X joined the game". On a livestream that reads as a disconnect.
 * This server-side mod drops only those two broadcasts, and only for the players listed in
 * config/curio-quiet-reconnect.txt (one name per line). Everything else, including the console log, is untouched.
 */
public class QuietReconnect implements ModInitializer {
    private static final Set<String> NAMES = new HashSet<>();

    @Override
    public void onInitialize() {
        Path file = FabricLoader.getInstance().getConfigDir().resolve("curio-quiet-reconnect.txt");
        try {
            if (!Files.exists(file)) {
                Files.writeString(file, "# Players whose join/leave messages are not broadcast (one per line)\nDeepseek\n", StandardCharsets.UTF_8);
            }
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String name = line.trim();
                if (!name.isEmpty() && !name.startsWith("#")) NAMES.add(name.toLowerCase(Locale.ROOT));
            }
        } catch (IOException e) {
            System.err.println("[curio-quiet-reconnect] cannot read " + file + ": " + e);
        }
        System.out.println("[curio-quiet-reconnect] hiding join/leave messages for " + NAMES);
        ServerMessageEvents.ALLOW_GAME_MESSAGE.register((server, message, overlay) -> !hidden(message));
    }

    public static boolean hidden(class_2561 text) {
        if (NAMES.isEmpty() || !(text.method_10851() instanceof class_2588 tr)) return false;
        String key = tr.method_11022();
        if (!key.equals("multiplayer.player.left") && !key.startsWith("multiplayer.player.joined")) return false;
        Object[] args = tr.method_11023();
        if (args.length == 0) return false;
        String who = args[0] instanceof class_2561 t ? t.getString() : String.valueOf(args[0]);
        return NAMES.contains(who.toLowerCase(Locale.ROOT));
    }
}
