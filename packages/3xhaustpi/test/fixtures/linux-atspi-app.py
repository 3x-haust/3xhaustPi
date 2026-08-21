#!/usr/bin/env python3

import os

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

GLib.set_application_name("3xhaustPi AT-SPI Fixture")
window = Gtk.Window(title="3xhaustPi AT-SPI Fixture")
window.set_default_size(360, 160)
window.connect("destroy", Gtk.main_quit)
layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
layout.set_border_width(18)
entry = Gtk.Entry()
entry.get_accessible().set_name("Query")
button = Gtk.Button(label="Run")
button.get_accessible().set_name("Run")


def complete(_button):
    button.set_label("Completed")
    button.get_accessible().set_name("Completed")


button.connect("clicked", complete)
layout.pack_start(entry, True, True, 0)
layout.pack_start(button, True, True, 0)
window.add(layout)
window.show_all()
print(os.getpid(), flush=True)
Gtk.main()
