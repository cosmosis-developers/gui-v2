"""Bundled subset of the CosmoSIS Inifile class (cosmosis.runtime.config).

This module is used as a fallback when the full ``cosmosis`` package is not
installed (e.g. because its Fortran/C extensions cannot be compiled in the
current environment).  When ``cosmosis`` *is* available the classes are
imported from there instead, so the behaviour is identical to the real package.

Only the two pure-Python classes required by the GUI are included here:
``IncludingConfigParser`` and ``Inifile``.  The source is verbatim from the
``cosmosis`` package (MIT licence).
"""

try:
    # Prefer the real cosmosis package when available.
    from cosmosis.runtime.config import Inifile, IncludingConfigParser  # noqa: F401
except Exception:  # ImportError, or compilation failures on some platforms
    # ── Verbatim copy from cosmosis/runtime/config.py ────────────────────
    import collections
    import configparser
    import io
    import os

    class IncludingConfigParser(configparser.ConfigParser):
        """Extension of ConfigParser that supports ``%include filename.ini``."""

        def __init__(self, defaults=None, print_include_messages=True,
                     no_expand_vars=False):
            self.no_expand_vars = no_expand_vars
            configparser.ConfigParser.__init__(
                self,
                defaults=defaults,
                dict_type=collections.OrderedDict,
                strict=False,
                inline_comment_prefixes=(";", "#"),
            )
            self.print_include_messages = print_include_messages

        def _read(self, fp, fpname):
            s = io.StringIO()
            for line in fp:
                if not self.no_expand_vars:
                    line = os.path.expandvars(line)
                if line.lower().startswith("%include"):
                    _, filename = line.split()
                    filename = filename.strip('"').strip("'")
                    if self.print_include_messages:
                        print(f"Reading included ini file: {filename}")
                    if not os.path.exists(filename):
                        raise ValueError(
                            f"Tried to include non-existent file {filename}"
                        )
                    sub_ini = self.__class__(filename)
                    sub_ini.write(s)
                else:
                    s.write(line)
            s.seek(0)
            return super()._read(s, fpname)

    class CosmosisConfigurationError(configparser.Error):
        pass

    class Inifile(IncludingConfigParser):
        """A ``(section, name) → value`` mapping backed by a ``.ini`` file."""

        def __init__(self, filename, defaults=None, override=None,
                     print_include_messages=True, no_expand_vars=False):
            IncludingConfigParser.__init__(
                self,
                defaults=defaults,
                print_include_messages=print_include_messages,
                no_expand_vars=no_expand_vars,
            )
            if isinstance(filename, dict):
                for section, values in filename.items():
                    self.add_section(section)
                    for key, value in values.items():
                        self.set(section, key, str(value))
            elif isinstance(filename, Inifile):
                s = io.StringIO()
                filename.write(s)
                s.seek(0)
                self.read_file(s)
            elif hasattr(filename, "read"):
                self.read_file(filename)
            elif filename is not None:
                if isinstance(filename, str) and not os.path.exists(filename):
                    raise IOError(
                        f"Unable to open configuration file `{filename}'"
                    )
                self.read(filename)

            if override:
                for section, name in override:
                    if section == "DEFAULT":
                        self._defaults[name] = override[(section, name)]
                    else:
                        if not self.has_section(section):
                            self.add_section(section)
                        self.set(section, name, override[(section, name)])

        def get(self, section, option, raw=False, vars=None,
                fallback=configparser._UNSET):
            try:
                return IncludingConfigParser.get(
                    self, section, option, raw=raw, vars=vars,
                    fallback=fallback
                )
            except (configparser.NoSectionError,
                    configparser.NoOptionError) as exc:
                if fallback is configparser._UNSET:
                    raise CosmosisConfigurationError(
                        f"CosmoSIS looked for '{option}' in '[{section}]' "
                        "but it was not in the ini file"
                    ) from exc
                return fallback

        def __getitem__(self, key):
            section, option = key
            return self.get(section, option)

        def __setitem__(self, key, value):
            section, option = key
            self.set(section, option, str(value))

        def __iter__(self):
            return (
                ((section, name), value)
                for section in self.sections()
                for name, value in self.items(section)
            )

        def getboolean(self, section, option, raw=False, vars=None,
                       fallback=configparser._UNSET):
            try:
                return IncludingConfigParser.getboolean(
                    self, section, option, raw=raw, vars=vars,
                    fallback=fallback
                )
            except ValueError:
                value = self.get(section, option).lower()
                if value in ("y", "yes", "t", "true"):
                    return True
                if value in ("n", "no", "f", "false"):
                    return False
                raise ValueError(
                    f"Cannot parse '{value}' as boolean "
                    f"for [{section}] {option}"
                )
            except (configparser.NoSectionError,
                    configparser.NoOptionError) as exc:
                if fallback is configparser._UNSET:
                    raise CosmosisConfigurationError(
                        f"CosmoSIS looked for boolean '{option}' in "
                        f"'[{section}]'"
                    ) from exc
                return fallback

        def gettyped(self, section, name):
            """Best-guess the type of a parameter."""
            import re
            value = IncludingConfigParser.get(self, section, name)
            value = value.strip()
            if not value:
                return None
            m = re.match(r"^(['\"])(.*?)\1$", value)
            if m is not None:
                return m.group(2)
            value_list = value.split()
            try:
                parsed = [int(s) for s in value_list]
                return parsed[0] if len(parsed) == 1 else parsed
            except ValueError:
                pass
            try:
                parsed = [float(s) for s in value_list]
                return parsed[0] if len(parsed) == 1 else parsed
            except ValueError:
                pass
            try:
                return self.getboolean(section, name)
            except ValueError:
                pass
            return value
