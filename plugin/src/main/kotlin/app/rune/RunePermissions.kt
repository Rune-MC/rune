package app.rune

import org.bukkit.permissions.Permission
import org.bukkit.permissions.PermissionDefault
import org.bukkit.plugin.PluginManager

internal fun registerRunePermission(pluginManager: PluginManager, name: String) {
    if (name.startsWith("rune.") && pluginManager.getPermission(name) == null) {
        pluginManager.addPermission(Permission(name, PermissionDefault.OP))
    }
}
